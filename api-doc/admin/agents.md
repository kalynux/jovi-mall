# Admin — Agent Administration

**Verified against source on 2026-09-08** — the 15-route surface (12 in `admin-agent.routes.ts` + 3 contract routes + `assignability` on its own router), the `AgentProfileMapper.toResponseDto` response shape, the transfer/status/tracking-allow response bodies, the eligibility `{eligible, reasons, rules}` shape, and the assignability gate statuses and remedy actions, against `jovi-mall/src/modules/agents/{routes/admin-agent.routes.ts,controllers/admin-agent.controller.ts,dto/agent-profile.dto.ts,domain/services/{agent-eligibility,agent-contract}.service.ts}` and `jovi-mall/src/modules/shipment-assignment/{admin-assignability.routes.ts,domain/services/{agent-assignability,contract-policy}.service.ts}`.

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/agents` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/agents`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/agents` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/api-doc/api/` in the wi-admin repository for the dashboard contract.

---

Platform-level administration of delivery agents: view an agent's full record, change account status,
control the tracking-allow flag, transfer an agent between agencies, and inspect eligibility/history.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: `requireAdminCaller` — a **service** call from wi-admin. `X-Service-Token`
  (`INTERNAL_ADMIN_SERVICE_TOKEN`, or the same value as `Authorization: Bearer`) plus `X-Actor-Id`,
  the administrator’s `admin_accounts._id`. **No user session, no cookie.**
- **Permissions**: resolved in **wi-admin**, before the call, and re-checked nowhere here — the
  token is a full-privilege credential.

> ⚠ **These two lines read *"Auth: Required (cookie or `Bearer`)"* and *"Permissions: `admin` only
> (`requireRole(['admin'])`)"* until 2026-09-08.** That is the authorization model deleted at the
> Phase 5 Part E cutover, and following it would mean building against a mount that does not exist.

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
| `POST` | `/internal/admin/agents/transfer` | Move an agent from one agency to another |
| `GET` | `/internal/admin/agents/:agentId` | Agent profile + every membership |
| `PATCH` | `/internal/admin/agents/:agentId/status` | Set account status (activate/suspend/…) |
| `PUT` | `/internal/admin/agents/:agentId/tracking-allow` | Enable/disable tracking-allow |
| `GET` | `/internal/admin/agents/:agentId/tracking-policy` | The tracking policy geo-tracker would see |
| `PUT` | `/internal/admin/agents/:agentId/kyc` | Set the KYC verdict — **required before the agent can be dispatched** |
| `PUT` | `/internal/admin/agents/:agentId/ban` | Ban or unban platform-wide |
| `PUT` | `/internal/admin/agents/:agentId/cod-threshold` | Set the agent's whole COD pool |
| `GET` | `/internal/admin/agents/:agentId/cod-allocation` | The pool, every contract's slice, and the headroom |
| `GET` | `/internal/admin/agents/:agentId/history` | Membership/lifecycle history |
| `GET` | `/internal/admin/agents/:agentId/eligibility?agencyId=` | Assignment-eligibility check for an agency — the **platform** rules only |
| `GET` | `/internal/admin/agents/:agentId/assignability?agencyId=&shipmentId=` | **Every** gate, platform **and contract**, with the numbers behind each |
| `POST` | `/internal/admin/agents/contracts/:contractId/suspend` | Freeze **one agent↔agency contract** |
| `POST` | `/internal/admin/agents/contracts/:contractId/reinstate` | Lift a suspension |
| `POST` | `/internal/admin/agents/contracts/:contractId/deactivate` | End the relationship — **no administrative override**; the counterparty and the cash conditions still apply, and it answers `{ request, contract, blockers }` with `contract: null` when they are not met |

> Route order matters: `/transfer` is declared **before** `/:agentId` so it is not read as an
> agent id — and the same applies to `/contracts/:contractId/*`, whose literal first segment
> would otherwise be matched as one.

> **The three `contracts/*` routes act on a CONTRACT, not on the agent.** Every other row here
> is keyed by `:agentId`; these resolve the contract's own `agency_id` and then run the ordinary
> agency-scoped transition, so the authority matrix, the legal `from` states, the status-request
> row and the membership-event history are the same code an agency desk runs. Their full
> specification is in
> [internal-service-api.md](./internal-service-api.md#added-in-the-dashboard-request-round); the
> dashboard-facing contract is `admin/api-doc/api/contracts.md` in the wi-admin repository.

> ⚠ **Added 2026-09-06** (DOC-PROGRAM F-17 class 6). This table listed 12 rows over a 15-route
> surface. The three above were served, specified on a sibling page, and absent from the page a
> reader looks an agent-administration route up on.

> `assignability` is served by a **second router** mounted at the same `/agents` prefix, because its
> handler lives in `shipment-assignment` and that module already imports `agents` — declaring the
> route in `admin-agent.routes.ts` would close an import cycle. Express tries routers at a shared
> prefix in order, and `/:agentId` never matches two segments, so nothing is shadowed.

---

## POST `/internal/admin/agents/transfer`

**Purpose**: Move an agent from one agency's roster to another. **Admin-only** — an agency must not be
able to pull an agent off a rival's roster.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller)

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
{
  "success": true,
  "data": {
    "from": { "id": "664memA...", "agencyId": "664agyA...", "status": "deactivated", "...": "an AgentMembershipDto" },
    "to":   { "id": "664memB...", "agencyId": "664agyB...", "status": "active",      "...": "an AgentMembershipDto" }
  },
  "message": "Agent transferred."
}
```

> [!NOTE]
> **`data` is the two contract rows, not an echo of the request.** This example echoed
> `{ agentId, fromAgencyId, toAgencyId }` until 2026-09-06; the controller returns
> `{ from: AgentMembershipMapper.toDto(result.from), to: … }`, so the deactivated source contract
> and the new destination contract both come back in full. Both are the same
> [`AgentMembershipDto`](../agency/agent-roster.md#agentmembershipdto) as the detail read's
> `memberships[]`.

> The transfer moves both membership sides as one unit; the source is deactivated before the destination
> threshold is checked against pooled COD headroom, and COD/wage settlement gates still apply.

---

## GET `/internal/admin/agents/:agentId`

**Purpose**: Return the agent's profile and **every** membership (across all agencies).

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

### Example success `200` (representative shape)

```json
{
  "success": true,
  "data": {
    "agent": {
      "id": "664agt...",
      "name": "Sam Rider",
      "status": "active",
      "statusReason": null,
      "availability": "online",
      "workingState": "available",
      "tracking": { "allowed": true, "reason": null, "changedAt": "2026-08-30T09:12:00.000Z", "changedByRole": "admin" },
      "capacity": { "maxActiveShipments": 20, "activeShipmentCount": 1, "remaining": 19 },
      "vehicleInfo": { "vehicle_type": "bike", "plate_number": "LT-4412", "color": "red", "photo": null }
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

> [!IMPORTANT]
> **`agent` is an `AgentProfileMapper.toResponseDto`, not the stored document** — so it is
> **camelCase** and its identifier is **`id`**. This block showed the raw Mongoose shape
> (`_id`, `working_state`, `vehicle_info`) until 2026-09-06; none of those keys is on the wire.
> `vehicleInfo`'s own three keys stay snake_case because `toVehicleSummaryDto` emits them that
> way — that is the DTO, not an oversight.
>
> ⚠ **There is no `cod` block on this response.** The example used to show one. An agent's COD
> pool and trust score are read from `GET /internal/admin/agents/:agentId/cod-allocation`, and
> the per-contract sub-allocation is `codThreshold` on each membership below.

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

## PATCH `/internal/admin/agents/:agentId/status`

**Purpose**: Set the agent's account status. Memberships are intentionally left intact so reinstatement
restores them.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

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
{ "success": true, "data": { "id": "664agt...", "status": "suspended", "statusReason": "KYC re-check pending", "...": "the full agent profile" }, "message": "Agent status set to suspended." }
```

> [!NOTE]
> **`data` is the whole `AgentProfileMapper.toResponseDto`**, the same object the detail read
> returns above — not the two-field acknowledgement this example used to show.
> `AgentProfileService.setStatus` returns `present(updated)`, so a client can re-render from the
> response without a follow-up GET. The `message` is built as `` `Agent status set to ${status}.` ``.
>
> ⚠ **The other two writes on this router return something narrower, so do not generalise this.**
> `PUT /tracking-allow` returns `toResponseDto(agent).tracking` — the tracking sub-object *alone* —
> and `POST /transfer` returns `{ from, to }`, two `AgentMembershipDto`s.

---

## PUT `/internal/admin/agents/:agentId/tracking-allow`

**Purpose**: Enable or disable the **tracking-allow** flag. jovi-mall owns this flag; geo-tracker
enforces it — flipping it here revokes/permits live tracking downstream.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `allowed` | boolean | ✅ | `true` permits tracking, `false` disables it |
| `reason` | string | conditionally | **Required when disabling** (`allowed: false`) |

### Example request

```json
{ "allowed": false, "reason": "Privacy complaint under review" }
```

### Example success `200`

```json
{
  "success": true,
  "data": {
    "allowed": false,
    "reason": "Privacy complaint under review",
    "changedAt": "2026-09-06T11:04:00.000Z",
    "changedByRole": "admin"
  },
  "message": "Tracking disabled for this agent."
}
```

> [!NOTE]
> **`data` is the `tracking` sub-object alone, not the agent.** The controller sends
> `AgentProfileMapper.toResponseDto(agent).tracking`. This response was undocumented until
> 2026-09-06. `message` is `Tracking enabled for this agent.` or `Tracking disabled for this
> agent.` — there is no other variant.

---

## GET `/internal/admin/agents/:agentId/tracking-policy`

**Purpose**: Return the tracking policy geo-tracker would resolve for this agent (what the tracking
service sees). Read-only.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

---

## PUT `/internal/admin/agents/:agentId/kyc`

**Purpose**: Record the KYC verdict for an agent.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

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

## PUT `/internal/admin/agents/:agentId/ban`

**Purpose**: Ban or unban an agent platform-wide.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

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

## PUT `/internal/admin/agents/:agentId/cod-threshold`

**Purpose**: Set the agent's **whole COD pool** — the most cash they may carry across every agency.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

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

Returns the same shape as `GET /internal/admin/agents/:agentId/cod-allocation`.

### Errors specific to this endpoint

| `error.code` | Status | When |
|---|---|---|
| `AGENT_COD_THRESHOLD_OUT_OF_BOUNDS` | 422 | Outside 0–5,000,000. `details: { requested, min, max }` |
| `AGENT_COD_THRESHOLD_BELOW_ALLOCATED` | 422 | Below the sum of the contracts' slices. `details: { requested, currentlyAllocated, shortfall, contracts[] }` — lower those first |

---

## GET `/internal/admin/agents/:agentId/cod-allocation`

**Purpose**: The agent's pool, each contract's slice of it, and the unallocated headroom. The view
to consult before changing either level.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

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

## GET `/internal/admin/agents/:agentId/history`

**Purpose**: Return the agent's append-only membership/lifecycle history.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

---

## GET `/internal/admin/agents/:agentId/eligibility`

**Purpose**: Evaluate whether the agent is eligible for assignment **for a given agency**, reporting
**every** failed rule at once (not banned · KYC verified · account active · holds an **active
contract** with the dispatching agency · online · tracking allowed · device location not disabled ·
under capacity).

> The rule is named `approved` and its failure reason `membership_not_approved`, but it passes only
> on an `active` contract — `observed.contractStatus` reports what was actually seen. Both names
> predate the `approved` → `active` status rename and are kept because they are part of the wire
> contract. See [agency/agent-roster.md](../agency/agent-roster.md#get-apiagencyagentsagentideligibility).

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `agencyId` | string (ObjectId) | ✅ | The dispatching agency to evaluate against |

### Example success `200` (representative shape)

> ⚠ **Corrected.** This block previously showed `{ eligible, failedRules }`. There is no
> `failedRules` field and never has been — `AgentEligibilityService.evaluate` returns `reasons`
> (the codes) and `rules` (every rule, passed ones included, each with `observed`). A client
> written against the old example would have read `undefined`.

```json
{
  "success": true,
  "data": {
    "agentId": "b0000000000000000000000a",
    "agencyId": "a9e7000000000000000000b2",
    "eligible": false,
    "reasons": ["tracking_not_allowed", "at_capacity"],
    "rules": [
      { "rule": "platform_ban", "passed": true,  "reason": null, "observed": { "banned": false, "reason": null } },
      { "rule": "tracking_allowed", "passed": false, "reason": "tracking_not_allowed",
        "observed": { "allowed": false, "reason": "admin_disabled" } }
    ],
    "activeShipmentCount": 20,
    "maxConcurrentShipments": 20
  }
}
```

---

## GET `/internal/admin/agents/:agentId/assignability`

**Purpose**: The complete "**why can this agent not take this work?**" answer — every gate the
assignment path applies, each with what the rule saw, one English line, and (where one exists) what
would fix it.

> **Why this exists beside `/eligibility`.** Assignment is gated by **two independent families** of
> rule and `/eligibility` reports only the first:
>
> | Family | Gates | Diagnosable before this endpoint |
> |---|---|---|
> | **platform** | banned · KYC · active · available · tracking allowed · device location · capacity | ✅ `/eligibility` |
> | **contract** | active contract · coverage region · per-shipment value ceiling · **COD exposure** | ❌ nowhere |
>
> The gap was not academic. An agency refused with `COD_AGENT_EXPOSURE_EXCEEDED` could read its own
> COD threshold off three screens and could see **neither** the agent's actual exposure (which counts
> undelivered COD packages, not just held cash, and spans **every** agency the agent serves) **nor**
> the trust multiplier that had halved that threshold. Support had the wrong number in front of them
> with no way to know it.

**Auth**: Required · **Permissions**: `admin` (service caller) · **Path param**: `agentId` (ObjectId)

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `agencyId` | string (ObjectId) | ✅ | The dispatching agency. The answer is pairwise — there is no agency-free verdict |
| `shipmentId` | string (ObjectId) | — | Optional **by design**. See below |

**With `shipmentId`**: every gate runs, including the two shipment-scoped ones (coverage region,
per-shipment value ceiling), and the cash gate is evaluated with that shipment's value added. The
shipment must belong to `agencyId` or the endpoint answers `404`.

**Without it**: those two report `"skipped"`, and the cash gate answers *"is this agent already at
their limit for this agency?"* with `additionalAmount: 0`. That is the question support asks first —
it usually arrives holding an agency and an agent and no shipment id at all.

### Gate statuses

| Status | Meaning |
|---|---|
| `passed` | The rule ran and allowed it |
| `failed` | The rule ran and refused. `reason` carries the `ERROR_CODES` value the assignment path throws |
| `skipped` | The rule **could not run** — no `shipmentId`, or no active contract to read terms from |
| `not_applicable` | The rule does not apply — e.g. the cash gate on a prepaid shipment |

`assignable` is true only when **no** gate is `failed`; `skipped` does not make it false.

### Example success `200` — the refusal this endpoint was built for

```json
{
  "success": true,
  "data": {
    "agentId": "b00000000000000000000006",
    "agencyId": "b00000000000000000000005",
    "shipmentId": "6a90228701508373b234f6e8",
    "assignable": false,
    "blockers": ["cod_exposure"],
    "gates": [
      { "family": "platform", "gate": "capacity", "status": "passed", "reason": null,
        "observed": { "activeShipmentCount": 6, "max": 20 },
        "summary": "Carrying 6 of a maximum 20 concurrent shipments.", "remedies": [] },
      { "family": "contract", "gate": "coverage_region", "status": "passed", "reason": null,
        "observed": { "deliveryRegion": "littoral", "countryCode": "CM", "coveredRegions": ["littoral"] },
        "summary": "The delivery region (littoral) is covered by this contract.", "remedies": [] },
      { "family": "contract", "gate": "cod_exposure", "status": "failed",
        "reason": "COD_AGENT_EXPOSURE_EXCEEDED",
        "observed": {
          "blocker": "exposure_exceeded",
          "additionalAmount": 100,
          "exposure": {
            "currency": "XAF",
            "cashHeld": 37400,
            "pendingCollections": {
              "total": 83000, "count": 5,
              "items": [
                { "collectionId": "…", "shipmentId": "…", "agencyId": "b00000000000000000000005", "expectedAmount": 26000 }
              ]
            },
            "total": 120400
          },
          "limit": {
            "contractThreshold": 200000, "base": 200000,
            "trustScore": 75, "trustSource": "computed", "computedTrustScore": 75, "overrideReason": null,
            "tier": "reduced", "multiplier": 0.5,
            "fullThreshold": 80, "reducedThreshold": 50,
            "effectiveLimit": 100000
          },
          "headroom": 0, "depositNeeded": 20500, "openCashShortfall": false
        },
        "summary": "Refused on cash: the agent is already exposed to 120400 (37400 held plus 83000 expected from 5 undelivered package(s), across every agency they serve) and this shipment adds 100, against a limit of 100000 — reduced trust (75, under 80), so the contract threshold of 200000 is halved to 100000.",
        "remedies": [
          { "action": "deposit_cash", "params": { "amount": 20500 } },
          { "action": "raise_trust_score", "params": { "to": 80, "from": 75, "wouldRaiseLimitTo": 200000, "sufficientOnItsOwn": true } },
          { "action": "raise_contract_threshold", "params": { "current": 200000, "requiredForCurrentExposure": 241000 } },
          { "action": "wait_for_deliveries" }
        ] }
    ],
    "context": {
      "shipment": { "shipmentId": "…", "status": "assigned", "agencyId": "…", "currentAgentId": null,
                    "orderId": "…", "paymentMethod": "cash_on_delivery", "currency": "XAF",
                    "value": 100, "deliveryRegion": "littoral" },
      "contract": { "contractId": "…", "status": "active", "codThreshold": 200000,
                    "outstandingBalance": 4200, "shipmentValueCeiling": null, "coverageRegions": ["littoral"] }
    },
    "eligibility": { "…": "the /eligibility payload, unmodified" },
    "contractPolicy": { "…": "the raw contract-gate result, including codVerdict" }
  }
}
```

### Three things to read carefully

1. **Exposure is agent-wide; the limit is per-contract.** `exposure.total` spans **every** agency the
   agent serves — the cash is one physical pot — while `limit.contractThreshold` belongs to the one
   agency in `agencyId`. Every `pendingCollections.items` row carries its own `agencyId` so the split
   is visible. This asymmetry is the single most misread thing about the refusal.
2. **`limit.contractThreshold` is not the limit.** `effectiveLimit` is, and it is the threshold scaled
   by the trust tier. A screen showing only the threshold tells an operator the opposite of what the
   gate decided.
3. **`trustScore` is the EFFECTIVE score** — an administrator's pinned override when one exists
   (`trustSource: "override"`), the computed score otherwise. `computedTrustScore` rides along so a
   screen can show both.

### Remedy actions

| `action` | `params` |
|---|---|
| `deposit_cash` | `amount` — the smallest deposit that makes the shipment fit |
| `raise_trust_score` | `to`, `from`, `wouldRaiseLimitTo`, `sufficientOnItsOwn` — offered only when the tier is not already `full` |
| `raise_contract_threshold` | `current`, `requiredForCurrentExposure`. ⚠ Bounded by the agent's COD pool — check `/cod-allocation` for headroom first |
| `resolve_cash_shortfall` | — |
| `add_coverage_region` | `region` |
| `raise_shipment_value_ceiling` | `required` |
| `activate_contract` | `contracts` — the non-active contracts that exist with this agency |
| `wait_for_deliveries` | — |

### Errors

| `error.code` | Status | When |
|---|---|---|
| `AGENT_NOT_FOUND` | 404 | No such agent |
| `SHIPMENT_NOT_FOUND` | 404 | No such shipment, **or** it belongs to a different agency than `agencyId` |
| `ORDER_NOT_FOUND` | 404 | The shipment's order is missing |
| `VALIDATION_ERROR` | 400 | `agencyId` absent or not a 24-hex id |

---

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
| which agency an agent belongs to | `POST /internal/admin/agents/transfer` | approving contracts for them |

### Transfers carry the terms across

`POST /internal/admin/agents/transfer` is the one admin action that creates a contract, and it lands the
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
