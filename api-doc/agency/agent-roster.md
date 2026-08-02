# Agent Roster (Agency-Facing)

## Base Path

```
/api/agency/agents
```

## Authentication

**Authorization**: Agency access required.

```
Authorization: Bearer <access_token>
```

All endpoints are scoped to the calling agency. A contract belonging to another agency reports
`404`, never `403` — an agency must not be able to probe whether an agent works for a rival.

---

## Overview

> **This is the canonical document for the agent↔agency contract.** The agent-facing
> [Agency membership](../agent/agency-membership.md) doc documents the agent's endpoints but
> defers here for the lifecycle, the DTO reference and the error catalogue. Keep this one correct
> and the other follows.

An agent is a **platform identity**, not an agency-owned record: the same agent may serve several
agencies at once (up to `AGENT_MAX_AGENCY_RELATIONSHIPS`, default 5). Your relationship with one is
a **contract**, and everything you negotiate about that agent lives on it — COD slice, fee split,
employment terms, remittance cadence, coverage. Nothing you set affects that agent at another
agency.

The shape mirrors the vendor↔agency [connection](./vendor-connections.md) flow deliberately: browse
a directory, request a specific counterparty, and the other side answers. The four handshake verbs
— `approve`, `reject`, `withdraw`, `terminate` — mean the same thing on every role's router across
both flows.

### The handshake

Two ways in, **symmetric**: both land in `pending`, and in both the party who did *not* raise the
request answers it.

| Path | Raised by | Answered by | Raiser may |
|---|---|---|---|
| **You approach an agent** | you — `POST /requests`, after finding them in `GET /browse` | the agent — `approve` or `reject` | `POST /:id/withdraw` while pending |
| **An agent applies** | the agent — `POST /api/agent/memberships/requests` | you — `approve` or `reject` | they withdraw |

`initiatedBy` (`agent` \| `agency`) on every contract tells you which case you are looking at, and
therefore which buttons to render. It is derived from `origin`: `join_request` means the agent
raised it, every other origin (`invitation`, `transfer`, `admin`, `migration`) means you or an
admin did. **Calling the wrong verb is a `403`, not a no-op** — the initiator may only withdraw,
the counterparty may only approve/reject.

> **There are no email invites.** `POST /api/agency/agents/invites` and its `GET`/`DELETE`
> siblings are gone, as is `GET /api/agent/invites`. You reach an agent by finding them in the
> directory and requesting them by `agentId`. The cost, accepted knowingly: you cannot approach
> someone who has not signed up yet.
>
> The names `origin: "invitation"`, `invitedAt` and the `invited` / `invite_accepted` event types
> survive that removal and are still emitted — they are residue of the old subsystem, not evidence
> it is still there. `origin: "invitation"` now simply means "the agency raised this".

### Status lifecycle

```
pending ──approve──> active <──reinstate── paused / suspended
   │                    │  │                        │
   ├──reject──> rejected   └──terminate──> deactivated <──┘
   └──withdraw──> withdrawn
```

| Status | Meaning |
|---|---|
| `pending` | awaiting whichever party did not raise it |
| `active` | dispatchable — the only status that passes the assignment gate |
| `paused` | a mutual break. Either side may raise it; the agent's needs your agreement |
| `suspended` | your disciplinary tool. No new assignments; **in-flight shipments are untouched** |
| `rejected` | the counterparty refused the request. Terminal |
| `withdrawn` | the raiser pulled the request back before it was answered. Terminal |
| `deactivated` | the relationship ended. Terminal |

**Terminal is terminal.** Contracting with the same agent again creates a **new** contract row; the
old one stays as history. This is why `GET /` returns every status by default — the terminal rows
*are* the relationship history.

**Suspend vs. terminate** — the distinction is operational:

| | Suspend | Terminate |
|---|---|---|
| New assignments | blocked | blocked |
| Shipments in flight | **kept, the agent works them** | must be zero first |
| Undeposited COD cash | irrelevant — the slice stays allocated | must be zero first |
| Unpaid agent earnings | irrelevant | must be zero first |
| Needs the agent's consent | no | **yes** |
| Reversible | yes (`reinstate`) | no (they must re-contract) |

Suspension is deliberately **not** blocked by in-flight work: you reach for it when someone must
stop taking new jobs *right now*, and requiring an empty queue would make it useless in the moment
it matters.

### Two-party changes

Some changes are one side's call; some need the other's agreement.

| Change | You may | The agent may |
|---|---|---|
| approve / reject a **pending** contract | on your own — only if **they** raised it | on their own — only if **you** raised it |
| withdraw a **pending** contract | on your own — only if **you** raised it | only if they raised it |
| suspend | on your own | never |
| pause | on your own | needs your agreement |
| reinstate | on your own | needs your agreement |
| **terminate** | **needs their agreement** | **needs your agreement** |

Anything needing agreement raises a **`ContractStatusRequest`** instead of moving the contract. The
counterparty clears it from their inbox (`GET /status-requests`), and only then does the contract
move. **The party who raised a request can never resolve it themselves** — that consent is the
point. At most one open request per contract per transition.

Requests carry `blockingConditions`, which is **advisory**: every condition is re-checked at
approval time, never trusted from when the request was raised, because cash can be collected in
between.

### The COD threshold is a sub-allocation

`cod.threshold` on a contract is a slice of the agent's own global pool (`cod.max_threshold`). The
sum across their **allocating** contracts — `active`, `paused` and `suspended` — may never exceed
it. Consequences worth knowing:

- A raise here can be refused because of a *different* agency's slice.
- Pausing or suspending does **not** free the slice: the agent may still be holding your cash. Only
  termination (which requires zero) returns capacity.
- Trust score, by contrast, is platform-wide — the agent holds one pot of cash whoever dispatched
  it, so trust follows the person.

---

## Endpoints

### GET /api/agency/agents/browse

**Description**: The platform-wide agent directory — how you find agents to work with. Each result
is annotated with your current contract state, so the UI can render the right button
(Request / Pending / Connected / Suspended).

Only agents who could actually accept are listed: `status: active`, **KYC verified**, not
platform-banned, onboarding complete. That is exactly the gate a request must clear, so a listed
agent is always a requestable one.

An agent already serving another agency **is listed** — agents are multi-agency by design. So is an
agent you already contract with; `contract` tells you which, so you can show "Connected" rather
than losing them from the list.

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | — | Case-insensitive, over the agent's name and home-base label |
| `vehicle_type` | string | — | `bike` \| `car` \| `van` \| `truck` |
| `availability` | string | — | `online` \| `offline` \| `on_break` — what the agent *wants* right now |
| `min_trust_score` | integer | — | 0–100 |
| `lng`, `lat`, `radius_km` | number | — | Radius search on the agent's declared home base. **All three or none** — a partial triple is `400` |
| `sort` | string | `trust` | `trust` (score descending) or `name` (ascending) |
| `page` | integer | `1` | |
| `limit` | integer | `20` | Max 100 |

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "name": "Jean Bakari",
      "avatar": { "id": "665f...", "key": "images/2026/07/jean.jpg", "url": "https://cdn.example.com/jean.jpg", "mimeType": "image/jpeg", "size": 20481, "originalName": "me.jpg" },
      "vehicleType": "bike",
      "homeBase": { "label": "Douala — Akwa", "coordinates": [9.7043, 4.0511], "serviceRadiusKm": 12 },
      "trustScore": 92,
      "kycVerified": true,
      "availability": "online",
      "workingState": "idle",
      "completedShipments": 431,
      "onTimeRate": 0.94,
      "ratings": {
        "customer": { "average": 4.7, "count": 210 },
        "agency": { "average": 4.8, "count": 12 },
        "vendor": { "average": null, "count": 0 }
      },
      "contract": { "id": "665f0000000000000000aa11", "status": "pending", "initiatedBy": "agency", "isPrimary": false }
    }
  ],
  "meta": { "total": 87, "page": 1, "limit": 20, "totalPages": 5 }
}
```

`contract` is `null` when you have no history with the agent. Otherwise it is the **live** contract
if there is one, else the most recent terminal one — a pair accumulates a row per contract, unlike
the vendor↔agency connection which reuses one document forever.

> **Never returned here**: `email`, `phone`, licence/national-ID, payout details, emergency contact,
> device telemetry, last known position, the agent's COD pool, or raw capacity counters. Load is the
> `workingState` label only. Contact details arrive with the contract — the roster below carries
> `email` and `phone`, the directory does not.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | `VALIDATION_ERROR` | Bad enum, or a partial `lng`/`lat`/`radius_km` triple |

---

### POST /api/agency/agents/requests

**Description**: Ask a specific agent to contract with you. Lands `pending`; **the agent** answers.

**Request Body**:
```json
{ "agentId": "507f1f77bcf86cd799439011" }
```

**Success Response** (`201 Created`): an `AgentMembershipDto`, `status: "pending"`,
`origin: "invitation"`, `initiatedBy: "agency"`, with the message *"Request sent. The agent must
accept before the contract becomes active."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `AGENT_NOT_FOUND` | `agentId` does not resolve to an agent |
| `409` | `AGENT_MEMBERSHIP_ALREADY_EXISTS` | A live contract with you already exists. `details: { status, contractId }` |
| `422` | `AGENT_KYC_NOT_VERIFIED` | `details: { kycStatus, hint }` |
| `403` | `AGENT_PLATFORM_BANNED` | A platform ban overrides every contract |
| `400` | `VALIDATION_ERROR` | `agentId` missing or not a valid ObjectId |

> The agent's relationship cap and COD headroom are **not** checked here — a request may always be
> raised, and it is *approval* that binds. Refusing at request time would hide the queue from the
> agent and give them nothing to act on.

---

### GET /api/agency/agents

**Description**: Your roster — contracts joined to their agent records, with cash held.

**Every status by default**, terminal rows included: this is the relationship history, not only who
is working today. Filter by `status`, or use `GET /eligible`, for the live view.

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | One of `pending` \| `active` \| `paused` \| `suspended` \| `rejected` \| `withdrawn` \| `deactivated`. Omitted returns **all** |
| `page` | integer | `1` | |
| `limit` | integer | `20` | Max 100 |

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "membership": {
        "id": "665f1f77bcf86cd799439300",
        "agentId": "507f1f77bcf86cd799439011",
        "agencyId": "507f1f77bcf86cd799439099",
        "status": "active",
        "origin": "invitation",
        "initiatedBy": "agency",
        "isPrimary": true,
        "employment": { "employmentType": "contractor", "employeeRef": "EMP-042", "startedAt": "2026-01-05T00:00:00.000Z", "endsAt": null },
        "remittanceTerms": { "cadence": "weekly", "dayOfWeek": 3, "dayOfMonth": null, "graceHours": 48 },
        "coverage": { "regions": ["Douala", "Yaoundé"], "area": null },
        "feeSplit": { "model": "percentage", "agentSharePercent": 70, "agentFlatFee": null, "currency": "XAF" },
        "shipmentValueCeiling": 500000,
        "codThreshold": 200000,
        "codOutstandingBalance": 45000,
        "invitedAt": "2026-01-04T09:00:00.000Z",
        "requestedAt": null,
        "approvedAt": "2026-01-05T00:00:00.000Z",
        "rejectedAt": null,
        "rejectionReason": null,
        "withdrawnAt": null,
        "withdrawalReason": null,
        "suspendedAt": null,
        "suspensionReason": null,
        "removedAt": null,
        "removalReason": null,
        "transferredToAgencyId": null,
        "createdAt": "2026-01-04T09:00:00.000Z",
        "updatedAt": "2026-01-05T00:00:00.000Z"
      },
      "agent": {
        "id": "507f1f77bcf86cd799439011",
        "name": "Jean Bakari",
        "email": "jean@example.com",
        "phone": "+237670000001",
        "avatar": { "id": "665f...", "key": "images/2026/07/jean.jpg", "url": "https://cdn.example.com/jean.jpg", "mimeType": "image/jpeg", "size": 20481, "originalName": "me.jpg" },
        "status": "active",
        "vehicleInfo": { "vehicle_type": "bike", "plate_number": "LT-4412", "color": "red" },
        "availability": "online",
        "workingState": "idle",
        "activeShipmentCount": 0,
        "trackingAllowed": true,
        "trustScore": 92
      },
      "cashHeld": 45000
    }
  ],
  "meta": { "total": 14, "page": 1, "limit": 20, "totalPages": 1 }
}
```

`cashHeld` is the agent's balance across **all** their agencies (the person's pot), while
`membership.codOutstandingBalance` is the slice attributable to **your** contract. They differ, and
the per-contract one is what gates termination.

---

### GET /api/agency/agents/:membershipId

**Description**: One contract plus the agent's full profile.

**Success Response** (`200 OK`): `{ "success": true, "data": { "membership": AgentMembershipDto, "agent": AgentProfileDto | null } }`

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not on your roster |

---

### POST /api/agency/agents/:membershipId/approve

**Description**: Accept an agent's application. `pending` → `active`.

**Request Body**: none. (COD threshold is set separately — see `/cod-limit`.)

**Success Response** (`200 OK`): the `AgentMembershipDto`, `status: "active"`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not on your roster |
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | **You** raised this request — the agent answers it. `details: { transition, party, initiator, hint }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more. `details: { transition, from, allowedFrom }` |
| `422` | `AGENT_KYC_NOT_VERIFIED` | Re-checked **here**, not at request time |
| `403` | `AGENT_PLATFORM_BANNED` | Likewise |
| `422` | `AGENT_MEMBERSHIP_LIMIT_REACHED` | The agent is at their agency cap. `details: { current, max }` |
| `422` | `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | The slice does not fit the agent's pool |

---

### POST /api/agency/agents/:membershipId/reject

**Description**: Refuse an agent's application. `pending` → `rejected` (terminal).

**Request Body**:
```json
{ "reason": "Outside our coverage area" }
```
Optional, ≤300 chars.

**Error Responses**: as `/approve` — `404 CONTRACT_NOT_FOUND`, `403 CONTRACT_TRANSITION_NOT_PERMITTED`,
`409 CONTRACT_INVALID_TRANSITION`.

---

### POST /api/agency/agents/:membershipId/withdraw

**Description**: Pull back a request **you** raised, while it is still `pending`. → `withdrawn`
(terminal). You may request the same agent again afterwards; that creates a new contract.

**Request Body**: `{ "reason": "Route filled" }` — optional, ≤300 chars.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | The **agent** raised this one — you `reject` it, you do not withdraw it |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more |

> `approve`/`reject` and `withdraw` are **not interchangeable**, and the server decides which
> applies from `initiatedBy`. Render the matching pair.

---

### POST /api/agency/agents/:membershipId/suspend

**Description**: Stop new assignments as a sanction. In-flight shipments are untouched by design.

**Request Body**: `{ "reason": "Repeated late deposits" }` — **required**.

**Success Response** (`200 OK`): the contract, `status: "suspended"`, with `suspensionReason` set.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `409` | `CONTRACT_INVALID_TRANSITION` | Only an `active` or `paused` contract can be suspended. `details: { transition, from, allowedFrom }` |

---

### POST /api/agency/agents/:membershipId/pause

**Description**: The softer sibling of suspend. Both stop new assignments and leave in-flight
shipments alone; the difference is meaning and symmetry — `paused` reads as a mutual break,
`suspended` as a sanction, and `pause` is the only one of the two the **agent** may also raise
(with your agreement). `reinstate` returns from either.

**Request Body**: `{ "reason": "Slow season" }` — optional.

**Error Responses**: `409 CONTRACT_INVALID_TRANSITION` — only an `active` contract can be paused.

---

### POST /api/agency/agents/:membershipId/reinstate

**Description**: Return a `paused` or `suspended` contract to `active`.

**Error Responses**: `409 CONTRACT_INVALID_TRANSITION` — `details: { transition, from, allowedFrom }`.

---

### POST /api/agency/agents/:membershipId/terminate

**Description**: Propose ending the contract.

> `DELETE /api/agency/agents/:membershipId` is the same handler under its original spelling, kept
> working. The `POST` form is canonical — it matches the agent's `/terminate` and the vendor↔agency
> flow's verb.

**This proposes termination; it does not perform it.** Ending a contract is not one party's call, so
it raises a `ContractStatusRequest` for the agent to clear, and the contract stays live meanwhile.
`membership` is `null` while the request is pending — which, on this first call, it always is.

**Request Body**: `{ "reason": "Contract ended" }` — optional.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "507f1f77bcf86cd799439055",
      "contractId": "507f1f77bcf86cd799439011",
      "transition": "deactivate",
      "targetStatus": "deactivated",
      "fromStatus": "active",
      "state": "pending",
      "requestedByRole": "agency",
      "blockingConditions": { "outstandingCod": 50000, "outstandingPayment": 0, "clear": false }
    },
    "membership": null
  },
  "message": "Removal requested. The contract ends once the agent agrees and any cash and unpaid earnings are settled."
}
```

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not on your roster |
| `409` | `CONTRACT_STATUS_REQUEST_ALREADY_PENDING` | One open termination per contract. `details: { requestId }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | Already `deactivated`, `rejected` or `withdrawn` |

On **approval** (not here), termination is refused while either side still owes the other:

| Status | Code | Description |
|--------|------|-------------|
| `422` | `CONTRACT_HAS_OUTSTANDING_COD` | `details: { outstandingCod, hint }`. Scoped to **this** contract — cash the agent owes another agency is none of your business |
| `422` | `CONTRACT_HAS_UNPAID_EARNINGS` | `details: { outstandingPayment, hint }`. You must pay the agent for work under this contract first |

Once both are zero, termination is immediate — there is deliberately no notice period. If the
deactivated contract was the agent's primary, another active one is promoted automatically.

---

### PATCH /api/agency/agents/:membershipId/employment

**Description**: Update employment terms.

**Request Body** (all optional; at least one required):
```json
{ "employment_type": "employee", "employee_ref": "EMP-042", "started_at": "2026-01-05", "ends_at": null }
```

`employment_type`: `employee` | `contractor` | `freelancer`. `ends_at` must not precede `started_at`.
`employee_ref` is *clearable*: `null` or `""` clears it; omit to leave unchanged.

Employment is **per-contract**: the same agent may be your employee and another agency's freelancer.

> A thin alias for `PATCH .../terms` below, kept because it predates it. New integrations should use
> `/terms`, which reaches every negotiated field including the fee split.

---

### PATCH /api/agency/agents/:membershipId/terms

**Description**: Update the negotiated terms. All groups optional; at least one required. Each group
merges field-by-field, so an omitted key keeps its value.

**Request Body**:
```json
{
  "fee_split": { "model": "percentage", "agent_share_percent": 40, "currency": "XAF" },
  "remittance_terms": { "cadence": "daily", "grace_hours": 24 },
  "coverage": { "regions": ["Douala", "Bonabéri"] },
  "shipment_value_ceiling": 250000
}
```

| Group | Fields |
|---|---|
| `employment` | `employment_type` (`employee`\|`contractor`\|`freelancer`), `employee_ref` *(clearable)*, `started_at`, `ends_at` |
| `remittance_terms` | `cadence` (`per_delivery`\|`daily`\|`weekly`\|`biweekly`\|`monthly`\|`on_demand`), `day_of_week` (0–6, weekly/biweekly), `day_of_month` (1–28), `grace_hours` (0–720) |
| `coverage` | `regions` (≤100 names), `area` (GeoJSON `Polygon` or `null`) |
| `fee_split` | `model` (`percentage`\|`flat`), `agent_share_percent` (0–100), `agent_flat_fee` (minor units), `currency` (3 letters) |
| `shipment_value_ceiling` | integer minor units, or `null` for no per-shipment cap |

> **`fee_split` is what pays the agent.** The earnings split divides by it twice — once for the
> agent's offer-time estimate, once for the actual at delivery — so it is validated for coherence
> up front rather than mispaying weeks later: a `percentage` model must end up with an
> `agent_share_percent`, a `flat` model with an `agent_flat_fee`. The patch is merged over the
> stored split before checking, so switching only `model` on a contract that already carries the
> other value is fine.
>
> **The agent's cut comes OUT of your delivery fee, never on top.** The vendor pays the same either
> way. You owe it; the platform pays it, through the agent's own earnings account.

> **`cod.threshold` is not settable here** — it is bounded by the agent's shared pool and has its
> own endpoint below.

**Success Response** (`200 OK`): the full `AgentMembershipDto`, which carries every one of these
groups back — `remittanceTerms`, `coverage`, `feeSplit`, `shipmentValueCeiling`. Populate a terms
editor from `GET /api/agency/agents/:membershipId` (same shape) rather than from local state.

> **The request is snake_case, the response camelCase.** `remittance_terms.day_of_week` in, and
> `remittanceTerms.dayOfWeek` back out — the write bodies mirror the stored document while every
> DTO on this API is camelCase. Map the two rather than assuming a round-trip of the same keys.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not on your roster |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | The resulting split has no value for its model. `details: { model, hint }` |

---

### PATCH /api/agency/agents/:membershipId/cod-limit

**Description**: Set this contract's slice of the agent's COD pool. See
[the sub-allocation note](#the-cod-threshold-is-a-sub-allocation) above.

**Request Body**: `{ "threshold": 500000 }` — minor units. Not nullable: `0` grants nothing, and is
the default.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": { "membershipId": "507f1f77bcf86cd799439011", "threshold": 500000, "headroomAfter": 200000 },
  "message": "COD threshold updated."
}
```

`headroomAfter` reports what is left of the agent's pool, so you learn your room without a second
request.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | No such contract on your roster |
| `422` | `CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS` | Outside the absolute per-contract bounds. `details: { requested, min, max }` |
| `422` | `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | The agent's pool has no room. `details: { requested, headroom, shortfall, hint }` |
| `422` | `CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING` | You cannot set a threshold beneath cash the agent already holds under this contract. `details: { requested, outstandingBalance, hint }` |

---

### GET /api/agency/agents/status-requests

**Description**: Contract changes an **agent** has raised that are waiting on your decision — a
pause, a reactivation, or a departure. Newest first.

Declared before `/:membershipId`, so `status-requests` is never read as a contract id.

**Success Response** (`200 OK`): an array of `ContractStatusRequestDto` — the same shape as the
`request` object returned by `/terminate`.

---

### POST /api/agency/agents/status-requests/:requestId/resolve

**Description**: Approve or reject a request the agent raised.

**Request Body**:
```json
{ "decision": "approve", "note": "Agreed" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `decision` | string | ✅ | `approve` or `reject` |
| `note` | string \| null | ❌ | ≤300 chars |

**You cannot resolve a request you raised.** Your own termination proposal is cleared by the *agent*,
from their inbox — that mutual consent is the whole point.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_STATUS_REQUEST_NOT_YOURS` | You raised it; the agent must resolve it |
| `404` | `CONTRACT_STATUS_REQUEST_NOT_FOUND` | Unknown, or not addressed to your agency |
| `409` | `CONTRACT_STATUS_REQUEST_NOT_PENDING` | Already resolved. `details: { state }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | The contract moved since the request was raised |
| `422` | `CONTRACT_HAS_OUTSTANDING_COD` / `CONTRACT_HAS_UNPAID_EARNINGS` | On approving a departure while either side still owes the other |

---

### GET /api/agency/agents/:membershipId/settlements

**Description**: This contract's cash history and what is still outstanding under it.

**Query Parameters**: `page` (default 1), `limit` (default 20, max 100).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "membershipId": "507f1f77bcf86cd799439011",
    "cod": { "threshold": 200000, "outstandingBalance": 45000, "lifetimeSettled": 1250000, "lastSettledAt": "2026-07-26T17:30:00.000Z" },
    "deposits": [
      { "id": "665f1f77bcf86cd799439600", "amount": 80000, "recipient": "agency", "status": "confirmed", "declaredAt": "2026-07-26T16:00:00.000Z", "confirmedAt": "2026-07-26T17:30:00.000Z" }
    ]
  },
  "meta": { "total": 12, "page": 1, "limit": 20 }
}
```

> A projection of the deposits already recorded in [cod-cash-management.md](./cod-cash-management.md),
> scoped to this one contract — not a separate ledger. `outstandingBalance` is the number that must
> reach zero before the contract can be terminated.

**Error Responses**: `404 CONTRACT_NOT_FOUND`.

---

### GET /api/agency/agents/eligible

**Description**: The agents you can dispatch **right now**, already filtered. Returns roster-entry
objects (the `agent` shape from `GET /`).

---

### GET /api/agency/agents/:agentId/eligibility

**Description**: Why one agent can or cannot be assigned right now.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "agentId": "507f1f77bcf86cd799439011",
    "agencyId": "507f1f77bcf86cd799439099",
    "eligible": false,
    "reasons": ["not_available", "at_capacity"],
    "rules": [
      { "rule": "platform_ban", "passed": true, "reason": null, "observed": { "banned": false, "reason": null } },
      { "rule": "kyc", "passed": true, "reason": null, "observed": { "kycStatus": "verified" } },
      { "rule": "active", "passed": true, "reason": null, "observed": { "status": "active" } },
      { "rule": "approved", "passed": true, "reason": null, "observed": { "contractStatus": "active" } },
      { "rule": "available", "passed": false, "reason": "not_available", "observed": { "availability": "on_break" } },
      { "rule": "tracking_allowed", "passed": true, "reason": null, "observed": { "allowed": true, "reason": null } },
      { "rule": "device_location", "passed": true, "reason": null, "observed": { "enabled": null, "provider": "self_reported" } },
      { "rule": "capacity", "passed": false, "reason": "at_capacity", "observed": { "activeShipmentCount": 5, "max": 5 } }
    ],
    "activeShipmentCount": 5,
    "maxConcurrentShipments": 5
  }
}
```

> **The rule is named `approved` and its reason `membership_not_approved`, but it passes only on an
> `active` contract** — `observed.contractStatus` shows which status was actually seen. The names
> predate the status rename and are kept because they are part of the wire contract; do not read
> them as evidence of an `approved` status.

> `maxConcurrentShipments` is the eligibility result's name for the agent's
> `capacity.max_active_shipments` — the plan-driven ceiling. There is no
> `settings.max_concurrent_shipments` field; that name was retired when capacity moved onto its own
> sub-document.

**Every** failing rule is reported, not just the first — a dispatcher shouldn't have to fix blockers
one at a time. `observed` shows what each rule actually saw, so a denial is explainable without
re-running anything.

**Reasons**: `agent_not_found`, `platform_banned`, `kyc_not_verified`, `agent_not_active`,
`membership_not_approved`, `not_available`, `tracking_not_allowed`, `device_location_disabled`,
`device_location_unknown`, `at_capacity`.

The same rules are enforced when you call
[`PATCH /api/agency/shipments/:id/assign-agent`](./shipments.md), which fails with
`422 AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` carrying `details: { reasons, rules }`.

---

### GET /api/agency/agents/:agentId/history

One agent's contract trail **within your agency**.

### GET /api/agency/agents/history

The whole roster's trail, newest first.

**Event types**: `invited`, `invite_accepted`, `invite_declined`, `invite_revoked`,
`join_requested`, `approved`, `request_declined`, `withdrawn`, `suspended`, `paused`, `reinstated`,
`removed`, `transferred_out`, `transferred_in`, `primary_changed`, `employment_updated`,
`terms_updated`, `cod_limit_changed`.

> `invited` is still emitted — it is what an agency raising a request records. The three
> `invite_*` types are only on historical rows from the removed email-invite subsystem; nothing
> emits them now. The log is append-only, so old values are never rewritten.

---

## Response Field Reference

### `AgentMembershipDto`

| Field | Type | Description |
|---|---|---|
| `id` | string | Contract id — the `:membershipId` in every path above |
| `agentId` / `agencyId` | string | The two parties |
| `status` | `"pending" \| "active" \| "paused" \| "suspended" \| "rejected" \| "withdrawn" \| "deactivated"` | See the lifecycle above |
| `origin` | `"invitation" \| "join_request" \| "transfer" \| "admin" \| "migration"` | How the contract began |
| `initiatedBy` | `"agent" \| "agency"` | Derived from `origin`; drives which buttons apply |
| `isPrimary` | boolean | The agent's default agency. Exactly one across their allocating contracts |
| `employment` | object | `employmentType`, `employeeRef`, `startedAt`, `endsAt` |
| `remittanceTerms` | object | `cadence`, `dayOfWeek`, `dayOfMonth`, `graceHours` |
| `coverage` | object | `regions` (string[]), `area` (GeoJSON `Polygon` \| null) |
| `feeSplit` | object | `model`, `agentSharePercent`, `agentFlatFee`, `currency` |
| `shipmentValueCeiling` | number \| null | Per-shipment value cap; `null` = uncapped |
| `codThreshold` | number | This contract's slice of the agent's pool, minor units. Defaults to `0` |
| `codOutstandingBalance` | number | Cash the agent holds attributable to **this** contract |
| `invitedAt` / `requestedAt` | string \| null | Set on the raising path — `invitedAt` when the agency raised it, `requestedAt` when the agent did |
| `approvedAt` | string \| null | |
| `rejectedAt` / `rejectionReason` | string \| null | |
| `withdrawnAt` / `withdrawalReason` | string \| null | |
| `suspendedAt` / `suspensionReason` | string \| null | |
| `removedAt` / `removalReason` | string \| null | Termination stamps. The field names predate the `deactivated` status |
| `transferredToAgencyId` | string \| null | Set when the contract ended because an admin moved the agent |
| `createdAt` / `updatedAt` | string | ISO 8601 |

> **Actor user ids are deliberately omitted.** An agency seeing which admin suspended an agent — or
> an agent seeing which agency staffer removed them — leaks identity across a role boundary. The
> role is enough to explain the action; the trail with ids stays admin-side.

The agent's own views add `agencyName` to this shape (`AgentMembershipWithAgencyDto`).

---

## TypeScript Reference

```typescript
type ContractStatus =
  | 'pending' | 'active' | 'paused' | 'suspended'
  | 'rejected' | 'withdrawn' | 'deactivated';

type ContractOrigin = 'invitation' | 'join_request' | 'transfer' | 'admin' | 'migration';
type ContractTransition = 'approve' | 'reject' | 'withdraw' | 'pause' | 'suspend' | 'reactivate' | 'deactivate';
type StatusRequestState = 'pending' | 'approved' | 'rejected' | 'cancelled';

interface AgentMembershipDto {
  id: string;
  agentId: string;
  agencyId: string;
  status: ContractStatus;
  origin: ContractOrigin;
  initiatedBy: 'agent' | 'agency';
  isPrimary: boolean;
  employment: {
    employmentType: 'employee' | 'contractor' | 'freelancer';
    employeeRef: string | null;
    startedAt: string | null;
    endsAt: string | null;
  };
  remittanceTerms: {
    cadence: 'per_delivery' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'on_demand';
    dayOfWeek: number | null;   // 0=Sunday … 6=Saturday, weekly/biweekly
    dayOfMonth: number | null;  // 1–28, monthly
    graceHours: number;
  };
  coverage: {
    regions: string[];
    area: { type: 'Polygon'; coordinates: number[][][] } | null;
  };
  feeSplit: {
    model: 'percentage' | 'flat';
    agentSharePercent: number | null;  // 0–100, when model is 'percentage'
    agentFlatFee: number | null;       // minor units, when model is 'flat'
    currency: string;
  };
  shipmentValueCeiling: number | null;
  codThreshold: number;
  codOutstandingBalance: number;
  invitedAt: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  removedAt: string | null;
  removalReason: string | null;
  transferredToAgencyId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ContractStatusRequestDto {
  id: string;
  contractId: string;
  agentId: string;
  agencyId: string;
  transition: ContractTransition;
  targetStatus: ContractStatus;
  fromStatus: ContractStatus;
  state: StatusRequestState;
  requestedByRole: 'agent' | 'agency' | 'admin' | 'system';
  reason: string | null;
  blockingConditions: { outstandingCod: number; outstandingPayment: number; clear: boolean } | null;
  autoApproved: boolean;
  createdAt: string;
}

/** A row from GET /browse. */
interface AgentDirectoryItemDto {
  id: string;
  name: string;
  avatar: FileDetail | null;
  vehicleType: 'bike' | 'car' | 'van' | 'truck' | null;
  homeBase: { label: string | null; coordinates: [number, number] | null; serviceRadiusKm: number | null };
  trustScore: number;
  kycVerified: boolean;
  availability: 'online' | 'offline' | 'on_break';
  workingState: 'idle' | 'working' | 'at_capacity';
  completedShipments: number;
  onTimeRate: number | null;
  ratings: Record<'customer' | 'agency' | 'vendor', { average: number | null; count: number }>;
  contract: { id: string; status: ContractStatus; initiatedBy: 'agent' | 'agency'; isPrimary: boolean } | null;
}
```

---

## Usage Examples

```
GET   /api/agency/agents/browse?search=bakari&vehicle_type=bike&sort=trust
POST  /api/agency/agents/requests                      { "agentId": "507f..." }
GET   /api/agency/agents?status=pending&page=1&limit=20
GET   /api/agency/agents/665f...
POST  /api/agency/agents/665f.../approve
POST  /api/agency/agents/665f.../reject                { "reason": "Outside coverage" }
POST  /api/agency/agents/665f.../withdraw              { "reason": "Route filled" }
POST  /api/agency/agents/665f.../suspend               { "reason": "Late deposits" }
POST  /api/agency/agents/665f.../reinstate
POST  /api/agency/agents/665f.../terminate             { "reason": "Contract ended" }
PATCH /api/agency/agents/665f.../terms                 { "fee_split": { "model": "flat", "agent_flat_fee": 1500 } }
PATCH /api/agency/agents/665f.../cod-limit             { "threshold": 500000 }
```

---

## Notifications

Three agency-facing situations, all gated on the `contractUpdated` preference
(see [notifications.md](./notifications.md)):

- `agent_contract.request_received` — an agent applied to deliver for you.
- `agent_contract.approved` — an agent accepted a request you raised.
- `agent_contract.rejected` — an agent refused a request you raised.

Each carries `contractId` and `agentName`, and deep-links to `agents/{{contractId}}`. The same three
event names are consumed by the **agent** stack with different copy; a `recipientRole` discriminator
in the payload decides whose they are. See
[the agent's side](../agent/agency-membership.md#notifications).

> Nothing is emitted for `withdraw`, `suspend`, `pause`, `reinstate` or the status-request
> transitions — those surface in the inbox (`GET /status-requests`) rather than as a push.

## Transfers

Moving an agent between agencies is **admin-only** — an agency must not be able to pull an agent off
a rival's roster. See [`POST /api/admin/agents/transfer`](../admin/agents.md).
