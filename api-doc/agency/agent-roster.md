# Agent Roster (Agency-Facing)

**Verified against source on 2026-09-08** — all 30 routes (the `DELETE` terminate alias included), the `terms_proposed_by` authority rule and its `details.proposer` payload, `awaitingDecisionFrom`, the four negotiable term groups and the agent-only pair, the COD-headroom error shape, the multi-agency cap and the eight contract notification templates, against `jovi-mall/src/modules/agents/`.

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

`initiatedBy` (`agent` \| `agency`) on every contract tells you which of the two cases above you are
looking at. It is derived from `origin`: `join_request` means the agent
raised it, every other origin (`invitation`, `transfer`, `admin`, `migration`) means you or an
admin did.

> ### ⚠ `initiatedBy` is AUDIT, not the button rule — use `awaitingDecisionFrom`
>
> This is the single easiest thing to get wrong on this page, and the source says so in as many
> words (`dto/agent-membership.dto.ts:79-83`): *"**Audit, not the button rule.** It used to be
> both, back when terms could not change after creation. Now a counter moves the right to approve
> to the other side while `origin` stays put, so a client rendering buttons from this field would
> offer Approve to the party who just made the offer."*
>
> The server's authority discriminator is **`terms_proposed_by`** — *"which party's terms are
> currently standing"* (`agent-contract.service.ts:1941-1957`). It **flips on every counter**, so
> the party entitled to answer changes as the negotiation moves, while `initiatedBy` never does.
> `awaitingDecisionFrom` on the DTO is that same rule, pre-computed for you
> ([DTO reference](#agentmembershipdto)).
>
> | Render | For |
> |---|---|
> | **Approve / Reject / Counter** | the party named by `awaitingDecisionFrom` |
> | **Withdraw** | the other party (the one whose terms are standing) |
> | **Propose terms** (no Approve at all) | either party when `termsProposedBy` is `null` |
>
> Keying off `initiatedBy` renders the wrong pair the moment anybody counters — and in the case
> where the **agent** countered an agency-raised contract, it offers the agency "Withdraw" on an
> offer it is supposed to answer, and offers the agent nothing at all to escape their own counter.

**Calling the wrong verb is a `403`, not a no-op** — whoever's terms are standing may only
withdraw, the counterparty may only approve/reject/counter.

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

A pending request has exactly two exits, and which one is yours depends on `requestedByRole`:

| `requestedByRole` | Your verb | Effect |
|---|---|---|
| the *other* party | `POST /status-requests/:id/resolve` | approve → the contract moves; reject → it does not |
| **you** | `POST /status-requests/:id/cancel` | the request is withdrawn; the contract never moves |

Asking for the wrong one is a `403 CONTRACT_STATUS_REQUEST_NOT_YOURS`. Cancelling frees the
per-(contract, transition) slot, so you may raise the same transition again afterwards.

Requests carry `blockingConditions`, which is **advisory**: every condition is re-checked at
approval time, never trusted from when the request was raised, because cash can be collected in
between.

### Coverage regions are PICKED, not typed

> 🆕 **Changed 2026-08-06 — UI change required.** `coverage.regions` on a contract used to be a
> free-text list. It is now the **same region picker as the "Coverage regions" section of your
> Location tab**, over the same catalogue, and a value that is not a region of your country is
> rejected. Replace the text input on your contract-terms form with a multi-select. Nothing about
> the endpoints, paths or field names changed — only what the values may be.

**The catalogue is your registered country's regions**, from `locations.json` — the identical list
your magazin's `coverage_areas` are validated against (see [Magazin](./magazin.md), same keys, e.g.
`littoral`, `centre`, `far_north`). Your `country` is on `GET /api/agency/profile`, set once at
onboarding.

Applies to **every** path that writes terms, yours and the agent's alike: `POST /requests`,
`PATCH /:id/terms`, `POST /:id/counter`, `POST /:id/terms-proposals`, and the agent's mirrors.

| Sent | Stored | Why |
|---|---|---|
| `"littoral"` | `littoral` | already a key |
| `"Littoral"` / `" LITTORAL "` | `littoral` | case and padding are forgiving |
| `"Extrême-Nord"` / `"Far North"` | `far_north` | localized names resolve to their key |
| `"Douala"` | — **`400`** | a city is not a region |
| `"Litoral"` | — **`400`** | a typo resolves to nothing |

The error is `400 CONTRACT_COVERAGE_REGION_INVALID`, with
`details: { invalid: string[], requiredCountry: "CM", allowedRegions: string[] }` — `allowedRegions`
is the full catalogue, so a stale picker can be repaired without a second request.

Two things are deliberately **not** errors:

- **`regions: []` means no restriction — it covers everywhere, not nowhere.** It is the default on
  every contract, and clearing coverage is a legitimate edit. Label the empty state
  "All regions" rather than "None".
- A **legacy agency with no `country`** on file skips the check entirely; its values pass through
  untouched. Handle a `null` country by falling back to a free-text field.

**You may select a region outside your own coverage areas.** The picker is scoped to the *country*,
not to your magazin's `coverage_areas` — an agency contracts agents for a region it is expanding
into before it declares it. **Mark your declared regions in the list** (a "you cover this" badge, or
a "Your coverage areas" group above the rest) so both parties can see the difference; do not
disable the others. The agent's side is given the same hint — see
[`agencyCoverageAreas`](../agent/agency-membership.md#coverage-regions-are-picked-not-typed).

**Rows written before this change may still hold free text** (`"Douala"`, `"Yaoundé"`). Reading is
unaffected — the assignment gate still resolves them loosely — but the first save of such a contract
must send valid keys. Render what you receive; send keys back.

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
      "avatar": { "id": "665f...", "key": "images/2026/07/jean.jpg", "url": "https://cdn.example.com/jean.jpg", "access": "public", "mimeType": "image/jpeg", "size": 20481, "originalName": "me.jpg" },
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

**Description**: Ask a specific agent to contract with you **on stated terms**. Lands `pending`;
**the agent** answers — they may accept, reject, or counter.

> ⚠️ **Breaking change.** `terms` is now REQUIRED and must contain `fee_split`. An invitation with
> no numbers in it would land the agent on the schema default, whose null `agent_share_percent`
> pays them **zero** — so a bare `{ agentId }` body is now a `400`.

**Request Body**:
```json
{
  "agentId": "507f1f77bcf86cd799439011",
  "terms": {
    "fee_split": { "model": "percentage", "agent_share_percent": 40, "currency": "XAF" },
    "remittance_terms": { "cadence": "daily", "grace_hours": 24 },
    "coverage": { "regions": ["littoral"] },
    "shipment_value_ceiling": 250000
  }
}
```

`terms` accepts the four **negotiable** groups only — `fee_split`, `remittance_terms`, `coverage`,
`shipment_value_ceiling`. `employment` is not negotiated (it is your own HR record) and has its own
endpoint; `cod.threshold` has `/cod-limit`.

**Success Response** (`201 Created`): an `AgentMembershipDto`, `status: "pending"`,
`origin: "invitation"`, `termsProposedBy: "agency"`, `termsVersion: 1`,
`awaitingDecisionFrom: "agent"`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | *(Zod)* | `terms` missing, or `terms.fee_split` missing |
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of your country. `details: { invalid, requiredCountry, allowedRegions }` |
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
        "coverage": { "regions": ["littoral", "centre"], "area": null },
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
        "avatar": { "id": "665f...", "key": "images/2026/07/jean.jpg", "url": "https://cdn.example.com/jean.jpg", "access": "public", "mimeType": "image/jpeg", "size": 20481, "originalName": "me.jpg" },
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

> `agent.vehicleInfo` here is the vehicle **summary** — `{ vehicle_type, plate_number, color }`, with
> no `photo` key. The detail endpoint returns the full profile, whose `vehicleInfo.photo` is a
> resolved file object or `null`; the list omits the key rather than reporting `photo: null` for a
> file it never looked up. `color` is a lowercase English token — see
> [agent/profile.md](../agent/profile.md) for the palette and render your own localized label.

`cashHeld` mirrors `membership.codOutstandingBalance`: cash this agent holds that is attributable to
**your** contract, and the figure that gates termination. It is deliberately **not** the agent's pot
across all their agencies — an agent may be carrying another agency's cash, and that is not yours to
see or to chase. It is also the ceiling on what you can record as a deposit: `POST /api/agency/cod/deposits`
rejects an amount above it with `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING`.

---

### GET /api/agency/agents/:membershipId

**Description**: One contract plus the agent's full profile.

**Success Response** (`200 OK`): `{ "success": true, "data": { "membership": AgentMembershipDto, "agent": AgentProfileDto | null } }`

> `agent.vehicleInfo` here is the **full** shape, including `photo` — a resolved file object
> (`{ id, key, url, access, mimeType, size, originalName }`) or `null`. The roster *list* above returns the
> photo-less summary instead, so it never reports `photo: null` for a file it did not look up.
> `color` is a lowercase English token (see [agent/profile.md](../agent/profile.md) for the palette);
> render your own localized label and swatch.

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
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | **Your** terms are the ones standing — the agent answers them. `details: { transition, party, proposer, hint }` (`proposer`, **not** `initiator`) |
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
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | The **agent's** terms are the ones standing — you `reject` or `counter` them, you do not withdraw them. `details.proposer` names the party whose terms they are |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more |

> `approve`/`reject` and `withdraw` are **not interchangeable**, and the server decides which
> applies from **`termsProposedBy`** — *not* from `initiatedBy`, which does not move when somebody
> counters. Render the pair `awaitingDecisionFrom` implies.

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

**Description**: Write the negotiated terms. All groups optional; at least one required. Each group
merges field-by-field, so an omitted key keeps its value.

> ⚠️ **Status-aware, and breaking on live contracts.**
>
> | Contract status | Behaviour |
> |---|---|
> | `pending` | Identical to `POST /:membershipId/counter`. If the agent's terms were standing, this is a **counter** and `awaitingDecisionFrom` flips to them. If yours were, it is a **revision** of your own unanswered offer — allowed, and the ball stays with the agent. Either way `termsVersion` bumps. |
> | `active` / `paused` / `suspended` | **`409 CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED`.** A live contract is pricing deliveries by its agreed `fee_split` right now. Use `POST /:membershipId/terms-proposals` instead — the agent answers, and the current terms stay in force until they do. |
>
> A `200` that sometimes meant "applied" and sometimes "proposed" would be worse than this break.

**Request Body**:
```json
{
  "fee_split": { "model": "percentage", "agent_share_percent": 40, "currency": "XAF" },
  "remittance_terms": { "cadence": "daily", "grace_hours": 24 },
  "coverage": { "regions": ["littoral", "centre"] },
  "shipment_value_ceiling": 250000
}
```

| Group | Fields |
|---|---|
| `employment` | `employment_type` (`employee`\|`contractor`\|`freelancer`), `employee_ref` *(clearable)*, `started_at`, `ends_at` |
| `remittance_terms` | `cadence` (`per_delivery`\|`daily`\|`weekly`\|`biweekly`\|`monthly`\|`on_demand`), `day_of_week` (0–6, weekly/biweekly), `day_of_month` (1–28), `grace_hours` (0–720) |
| `coverage` | `regions` (≤100 **region keys of your country** — see [Coverage regions are picked, not typed](#coverage-regions-are-picked-not-typed); `[]` = no restriction), `area` (GeoJSON `Polygon` or `null`) |
| `fee_split` | `model` (`percentage`\|`flat`), `agent_share_percent` (0–100), `agent_flat_fee` (minor units), `currency` (3 letters) |
| `shipment_value_ceiling` | integer minor units, or `null` for no per-shipment cap |

> **`fee_split` is what pays the agent.** The earnings split divides by it three times — the agent's
> offer-time estimate, **your own estimate** (`agencyEarning.agentCut` on
> [your shipment views](./shipments.md#money)), and the actual at delivery — so it is validated for
> coherence up front rather than mispaying weeks later: a `percentage` model must end up with an
> `agent_share_percent`, a `flat` model with an `agent_flat_fee`. The patch is merged over the
> stored split before checking, so switching only `model` on a contract that already carries the
> other value is fine.
>
> **The agent's cut comes OUT of your delivery fee, never on top.** The vendor pays the same either
> way. You owe it; the platform pays it, through the agent's own earnings account. Changing this
> split changes what every un-delivered shipment will pay you — the estimates on your shipment list
> move with it, because they are read from the live contract, not snapshotted at assignment.

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
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of your country. `details: { invalid, requiredCountry, allowedRegions }` |
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
| `422` | `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | The agent's pool has no room. `details: { requested, headroom, shortfall, hint }`. Since 2026-09-21 the pool is automatic (0 until the agent is verified, then their plan's value) and the agent may lower it themselves, so the fix is on the agent's side or another agency's slice. `hint` is prose: display it, never parse it |
| `422` | `CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING` | You cannot set a threshold beneath cash the agent already holds under this contract. `details: { requested, outstandingBalance, hint }` |

---

### GET /api/agency/agents/status-requests

**Description**: Every **pending** contract change on your roster, newest first — a pause, a
reactivation, or a departure.

**Both directions appear here, and that is required, not incidental.** The query filters on your
agency and on `pending`, nothing else, so the list carries the requests an agent raised that await
*your* decision **and** the ones you raised that await *theirs*. This endpoint is the **only** place
a `requestId` is exposed, so dropping the rows you raised would leave `/cancel` uncallable.

**Read `awaitingMyDecision`, don't count rows.** It is `true` only on rows that are yours to answer,
and `availableActions` names the verbs you may call:

| `requestedByRole` | `awaitingMyDecision` | `availableActions` | Render |
|---|---|---|---|
| `agent` | `true` | `["approve","reject"]` | "Wants to leave — Approve / Reject" |
| `agency` | `false` | `["cancel"]` | "You proposed removing them — Cancel" |

Both fields are computed server-side from the same rule the service guards enforce, so a button this
DTO offers is one the service will accept. Use `awaitingMyDecision` for the sidebar badge —
counting rows over-counts by every request you raised yourself, and rendering a self-raised row as
"Approve" produces a `403 CONTRACT_STATUS_REQUEST_NOT_YOURS` on click.

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

### POST /api/agency/agents/status-requests/:requestId/cancel

**Description**: Pull back a still-pending request **you** raised — a termination proposal thought
better of, most often. The exact inverse of `/resolve`: that one answers the agent's requests, this
one withdraws your own.

**The contract is untouched.** A cancelled request never moved it, so there is nothing to undo and
nothing to settle: outstanding COD and unpaid earnings gate *ending* a contract, not abandoning a
proposal to end one. Consequently there is no `422` here, and `membership` is always `null`.

Cancelling frees the per-(contract, transition) pending slot, so you may raise the same transition
again afterwards. It appends no membership-history event — a cancelled request moved no state, and
the request row's own `state` / `resolvedByRole` / `resolvedAt` is the complete trail.

**Request Body** (optional):
```json
{ "note": "Sorted it out with him directly" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `note` | string \| null | ❌ | ≤300 chars. Stored as `resolutionNote` |

**Success Response** (`200 OK`): same shape as `/resolve` —
`{ request: ContractStatusRequestDto, membership: null }`, with `request.state` now `cancelled`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_STATUS_REQUEST_NOT_YOURS` | The **agent** raised it — answer it with `/resolve` instead. `details: { requestedByRole, hint }` |
| `404` | `CONTRACT_STATUS_REQUEST_NOT_FOUND` | Unknown, or not on your roster |
| `409` | `CONTRACT_STATUS_REQUEST_NOT_PENDING` | Already resolved. `details: { state }`. This is also what a cancel racing the agent's approval returns to the loser — the write is a compare-and-set on `pending`, so exactly one of the two wins |

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
| `initiatedBy` | `"agent" \| "agency"` | Derived from `origin`. **Audit only — no longer the button rule**, see `awaitingDecisionFrom` |
| `termsProposedBy` | `"agent" \| "agency" \| null` | Whose terms are currently standing. `null` = nobody has proposed any |
| `termsVersion` | number | Bumps on every counter, revision and accepted proposal. `0` = terms were never stated |
| `awaitingDecisionFrom` | `"agent" \| "agency" \| null` | **The button rule.** Who must answer the standing offer; the other party sees Withdraw. `null` when the contract is not `pending`, or when `termsProposedBy` is `null` |
| `openTermsProposalId` | string \| null | The open proposal on a live contract, when the endpoint resolved one. **Most endpoints return `null` here regardless** — the `/terms-proposals` endpoints are authoritative |
| `isPrimary` | boolean | The agent's default agency. Exactly one across their allocating contracts |
| `employment` | object | `employmentType`, `employeeRef`, `startedAt`, `endsAt` |
| `remittanceTerms` | object | `cadence`, `dayOfWeek`, `dayOfMonth`, `graceHours` |
| `coverage` | object | `regions` (string[] of **region keys** — `[]` = no restriction; legacy rows may hold free text), `area` (GeoJSON `Polygon` \| null) |
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

The agent's own views add three counterparty fields to this shape
(`AgentMembershipWithAgencyDto`): `agencyName`, `agencyCountry` and `agencyCoverageAreas`. The last
two exist because an agent cannot read your magazin, and their coverage picker needs the same
catalogue and the same "which of these does the agency actually serve" hint your own does. See
[the agent doc](../agent/agency-membership.md#coverage-regions-are-picked-not-typed).

### `ContractTermsProposalDto`

Returned by every `/terms-proposals` endpoint. Describes a proposed change to a **live** contract —
a pending contract carries its offer on the contract itself and produces no proposal rows.

| Field | Type | Description |
|---|---|---|
| `id` | string | The `:proposalId` in the resolve/cancel/counter paths |
| `contractId` | string | The contract this would change |
| `agentId` / `agencyId` | string | The two parties |
| `proposedByRole` | `"agent" \| "agency"` | Who raised it — decides whether `/resolve` or `/cancel` is your verb |
| `state` | `"pending" \| "accepted" \| "rejected" \| "withdrawn" \| "superseded"` | `superseded` means the other side countered it; the negotiation continued |
| `awaitingMyDecision` | boolean | True when pending **and** the other party raised it. The right predicate for a badge — a raw row count over-counts by every proposal you raised |
| `availableActions` | `Array<"approve" \| "reject" \| "counter" \| "cancel">` | Exactly the verbs the server will accept from you, in render order. Empty once resolved |
| `termsBefore` | object | The agreed terms **as they stood when this was raised** — snapshotted, not re-derived, so the diff stays honest after the contract moves on |
| `proposedTerms` | object | The patch being proposed. Only the groups it names are changing |
| `diff` | `TermsDiffEntry[]` | `termsBefore` → `proposedTerms` flattened to one entry per **changed** leaf. An unchanged restatement yields `[]` |
| `supersedesId` | string \| null | The proposal this one counters — walk it to reconstruct the chain |
| `note` | string \| null | Free text from the proposer |
| `resolvedByRole` | `"agent" \| "agency" \| null` | Null while pending. Set by resolve, cancel **and** counter |
| `resolvedAt` | string \| null | ISO 8601 |
| `resolutionNote` | string \| null | The `note` from whichever verb closed it |
| `createdAt` / `updatedAt` | string | ISO 8601 |

`TermsDiffEntry` is `{ path: string; before: unknown; after: unknown }`, where `path` is dotted
within the term groups — `fee_split.agent_share_percent`, `coverage.regions`,
`remittance_terms.cadence`. `shipment_value_ceiling` is a scalar group and appears at its bare name.

> **`availableActions` is computed from the same guards the service enforces**, so a button this DTO
> offers is one the server will accept. Note it is viewer-dependent: an agent reading a proposal that
> changes only `remittance_terms` is offered `approve` and `reject` but **not** `counter`, because
> that group is not theirs to author.

---

## TypeScript Reference

```typescript
type ContractStatus =
  | 'pending' | 'active' | 'paused' | 'suspended'
  | 'rejected' | 'withdrawn' | 'deactivated';

type ContractOrigin = 'invitation' | 'join_request' | 'transfer' | 'admin' | 'migration';
type ContractTransition = 'approve' | 'reject' | 'withdraw' | 'pause' | 'suspend' | 'reactivate' | 'deactivate';
type StatusRequestState = 'pending' | 'approved' | 'rejected' | 'cancelled';
type TermsProposalState = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'superseded';

/** The four groups that are negotiated. `employment` and `codThreshold` are not. */
type NegotiableTermGroup = 'fee_split' | 'remittance_terms' | 'coverage' | 'shipment_value_ceiling';
/** The subset an AGENT may author. Anything else from them is 403. */
type AgentNegotiableTermGroup = 'fee_split' | 'coverage';

/** The request/counter/proposal body. Every group optional; at least one required. */
interface NegotiableTermsInput {
  fee_split?: {
    model?: 'percentage' | 'flat';
    agent_share_percent?: number | null;  // 0–100
    agent_flat_fee?: number | null;       // minor units, integer
    currency?: string;                    // 3 letters, upper-cased
  };
  coverage?: {
    /**
     * ≤100 region KEYS of the agency's country (locations.json) — the same
     * catalogue the agency's own coverage_areas use. A localized name is
     * accepted and canonicalised; a city or a typo is 400
     * CONTRACT_COVERAGE_REGION_INVALID. [] = no restriction (covers everywhere).
     */
    regions?: string[];
    area?: { type: 'Polygon'; coordinates: number[][][] } | null;
  };
  // Agency-only from here down.
  remittance_terms?: {
    cadence?: 'per_delivery' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'on_demand';
    day_of_week?: number | null;          // 0–6
    day_of_month?: number | null;         // 1–28
    grace_hours?: number;                 // 0–720
  };
  shipment_value_ceiling?: number | null;
}

interface AgentMembershipDto {
  id: string;
  agentId: string;
  agencyId: string;
  status: ContractStatus;
  origin: ContractOrigin;
  /** Audit only. Use `awaitingDecisionFrom` to decide which buttons to render. */
  initiatedBy: 'agent' | 'agency';
  /** Whose terms are standing. null = nobody has proposed any yet. */
  termsProposedBy: 'agent' | 'agency' | null;
  /** Bumps on counter, revision and accepted proposal. 0 = never stated. */
  termsVersion: number;
  /**
   * THE button rule. Who must answer the standing offer — the other party sees
   * Withdraw. null in two distinct cases the UI must tell apart:
   *   - status !== 'pending'      → there is no offer on the table;
   *   - termsProposedBy === null  → nobody may approve; the agency owes a
   *                                 proposal, so its control reads "Propose terms".
   */
  awaitingDecisionFrom: 'agent' | 'agency' | null;
  /** Only populated by endpoints that resolve proposals; null elsewhere. */
  openTermsProposalId: string | null;
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
    /** Region keys. [] = no restriction. Legacy rows may hold free text. */
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
  /** Who raised it — and therefore whether /resolve or /cancel is your verb. */
  requestedByRole: 'agent' | 'agency' | 'admin' | 'system';
  /**
   * True when this row is pending AND the other party raised it, i.e. it is
   * yours to answer. False on rows you raised (those are yours to /cancel) and
   * on rows already resolved. The right predicate for an unread badge.
   */
  awaitingMyDecision: boolean;
  /** The verbs you may call on this row, in render order. Empty once resolved. */
  availableActions: Array<'approve' | 'reject' | 'cancel'>;
  reason: string | null;
  /** Null while `state` is 'pending'. Set by /resolve AND by /cancel. */
  resolvedByRole: 'agent' | 'agency' | 'admin' | 'system' | null;
  resolvedAt: string | null;
  /** The `note` from whichever of /resolve or /cancel closed it. */
  resolutionNote: string | null;
  blockingConditions: { outstandingCod: number; outstandingPayment: number; clear: boolean } | null;
  autoApproved: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TermsDiffEntry {
  /** Dotted within the term groups, e.g. 'fee_split.agent_share_percent'. */
  path: string;
  before: unknown;
  after: unknown;
}

interface ContractTermsProposalDto {
  id: string;
  contractId: string;
  agentId: string;
  agencyId: string;
  /** Who raised it — and therefore whether /resolve or /cancel is your verb. */
  proposedByRole: 'agent' | 'agency';
  /** 'superseded' = the other side countered it; the negotiation continued. */
  state: TermsProposalState;
  /** Pending AND raised by the other party, i.e. yours to answer. Badge predicate. */
  awaitingMyDecision: boolean;
  /** Exactly the verbs the server accepts from THIS viewer. Empty once resolved. */
  availableActions: Array<'approve' | 'reject' | 'counter' | 'cancel'>;
  /** The agreed terms when this was raised — snapshotted, so the diff stays honest. */
  termsBefore: Record<string, unknown>;
  proposedTerms: Record<string, unknown>;
  /** One entry per CHANGED leaf. A no-op restatement yields []. */
  diff: TermsDiffEntry[];
  /** The proposal this one counters. Walk it to rebuild the chain. */
  supersedesId: string | null;
  note: string | null;
  resolvedByRole: 'agent' | 'agency' | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
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
POST  /api/agency/agents/requests                      { "agentId": "507f...", "terms": { "fee_split": { "model": "percentage", "agent_share_percent": 40 } } }
GET   /api/agency/agents?status=pending&page=1&limit=20
GET   /api/agency/agents/665f...
POST  /api/agency/agents/665f.../approve
POST  /api/agency/agents/665f.../reject                { "reason": "Outside coverage" }
POST  /api/agency/agents/665f.../withdraw              { "reason": "Route filled" }
POST  /api/agency/agents/665f.../counter               { "fee_split": { "agent_share_percent": 35 } }
POST  /api/agency/agents/665f.../suspend               { "reason": "Late deposits" }
POST  /api/agency/agents/665f.../reinstate
POST  /api/agency/agents/665f.../terminate             { "reason": "Contract ended" }
PATCH /api/agency/agents/665f.../terms                 { "fee_split": { "model": "flat", "agent_flat_fee": 1500 } }   # pending only; 409 on a live contract
PATCH /api/agency/agents/665f.../cod-limit             { "threshold": 500000 }
GET   /api/agency/agents/status-requests
POST  /api/agency/agents/status-requests/778a.../resolve  { "decision": "approve" }
POST  /api/agency/agents/status-requests/778a.../cancel   { "note": "Sorted it out directly" }
POST  /api/agency/agents/665f.../terms-proposals       { "terms": { "remittance_terms": { "cadence": "weekly", "day_of_week": 5 } }, "note": "Moving to Friday settlement" }
GET   /api/agency/agents/665f.../terms-proposals
GET   /api/agency/agents/terms-proposals
POST  /api/agency/agents/terms-proposals/99ab.../resolve  { "decision": "approve" }
POST  /api/agency/agents/terms-proposals/99ab.../counter  { "terms": { "fee_split": { "agent_share_percent": 38 } } }
POST  /api/agency/agents/terms-proposals/99ab.../cancel   { "note": "Withdrawing for now" }
```

### A full negotiation, end to end

```
# 1. You invite on your terms. The agent must answer.
POST /api/agency/agents/requests
     { "agentId": "507f...", "terms": { "fee_split": { "model": "percentage", "agent_share_percent": 30 } } }
  → 201  termsProposedBy: "agency", termsVersion: 1, awaitingDecisionFrom: "agent"

# 2. They want more. The ball comes back to you.
     (agent calls POST /api/agent/memberships/665f.../counter)
  → GET /api/agency/agents/665f...
    termsProposedBy: "agent", termsVersion: 2, awaitingDecisionFrom: "agency"
    feeSplit.agentSharePercent: 45

# 3. You split the difference.
POST /api/agency/agents/665f.../counter   { "fee_split": { "agent_share_percent": 38 } }
  → 200  termsProposedBy: "agency", termsVersion: 3, awaitingDecisionFrom: "agent"

# 4. They accept. Only now does the contract go live.
     (agent calls POST /api/agent/memberships/665f.../approve)
  → status: "active", awaitingDecisionFrom: null
```

At step 4, `assertTermsApprovable` re-runs: a contract can never reach `active` carrying a fee split
that cannot pay.

---

## Notifications

Eight agency-facing situations, all gated on the `contractUpdated` preference
(see [notifications.md](./notifications.md)).

The handshake that **forms** a contract:

- `agent_contract.request_received` — an agent applied to deliver for you.
- `agent_contract.approved` — an agent accepted a request you raised.
- `agent_contract.rejected` — an agent refused a request you raised.

Changes to a contract that **already exists** — the status-request inbox above:

- `agent_contract.status_request_raised` — an agent proposed a change that needs your answer, most
  often asking to leave. Fires only for transitions that actually stay pending; a `unilateral` one
  self-clears and never waits on anyone.
- `agent_contract.status_request_resolved` — a pending change was approved, declined, or cancelled.
  It covers both "the agent answered what you raised" and "the agent withdrew what you were waiting
  on", so the copy names the change rather than whose request it was.

Changes to the **terms**:

- `agent_contract.terms_countered` — the agent countered the terms on a **pending** contract. The
  right to accept is now yours; an agency that believes its own offer is still on the table will not
  go and look.
- `agent_contract.terms_proposed` — the agent proposed a change to a **live** contract. The copy
  states that **the current terms stay in force until you answer** — that clause is load-bearing, not
  reassurance: a recipient who assumes the change already happened will act on the wrong number.
- `agent_contract.terms_resolved` — a proposal was accepted, declined, withdrawn or superseded.
  Deliberately neutral about whose it was, for the same reason as `status_request_resolved`: it
  covers both "the agent answered yours" and "the agent withdrew the one you were waiting on".

Each carries `contractId` and `agentName`, and deep-links to `agents/{{contractId}}`; the two
`status_request_*` events also carry `requestId`, `transition` and `state`, and are made idempotent
on the **request** id. The `terms_proposed`/`terms_resolved` pair carries `proposalId`,
`proposedByRole`, `state` and `changedTerms` (the group names), and is idempotent on the **proposal**
id; `terms_countered` is idempotent on the contract id **plus the emission time**, since a
negotiation is a sequence of counters on one contract and keying on the contract alone would suppress
every counter after the first.

All eight event names are consumed by the **agent** stack with different copy; a `recipientRole`
discriminator in the payload decides whose they are. See
[the agent's side](../agent/agency-membership.md#notifications).

> **WhatsApp is dark for the three new situations** until `agency_agent_contract_terms_countered`,
> `_terms_proposed` and `_terms_resolved` are created and approved in Meta Business Manager. In-app,
> email, Telegram and push work today. Same bootstrapping step every new situation needs — see
> [whatsapp-templates.md](../notifications/whatsapp-templates.md).

> Nothing is emitted for `withdraw`, `suspend`, `pause`, `reinstate` or the status-request
> transitions — those surface in the inbox (`GET /status-requests`) rather than as a push.

## Transfers

Moving an agent between agencies is **admin-only** — an agency must not be able to pull an agent off
a rival's roster. See [`POST /api/internal/admin/agents/transfer`](../admin/agents.md).

---

## Terms negotiation

The four negotiable groups — `fee_split`, `remittance_terms`, `coverage`, `shipment_value_ceiling` —
are **agreed, not assigned**. Two mechanisms, and which one applies is decided entirely by the
contract's status.

| Status | Mechanism | Why |
|---|---|---|
| `pending` | Terms are written **onto the contract**; a counter flips who may approve. | Nothing has been agreed and no work has been done, so the contract document *is* the offer. |
| `active` · `paused` · `suspended` | Terms are written to a separate **proposal**, and applied only on acceptance. | There is an agreed set that deliveries are being priced by right now, and it must keep applying until the other party agrees to replace it. |

**`awaitingDecisionFrom` on `AgentMembershipDto` is the button rule** — not `initiatedBy`, which is
now audit only. It names the party who must answer the standing offer; the *other* party sees
Withdraw. It is `null` in two distinct cases a client must tell apart:

- the contract is not `pending` — there is no offer on the table;
- `termsProposedBy` is `null` — **nobody has proposed terms**, so nobody may approve. Your control
  here is *Propose terms*, not *Approve*. (This is where a bare agent join request lands, and where
  legacy contracts whose fee split was never configured were migrated to.)

Approving a contract with no proposed terms is `422 CONTRACT_TERMS_NOT_PROPOSED`. Approving one
whose split cannot pay — a `percentage` model with a null share, which resolves to a cut of **zero**
— is `422 CONTRACT_FEE_SPLIT_INVALID`.

### Who may write what

| Term group | You propose | Agent may counter | On a live contract |
|---|---|---|---|
| `fee_split` | yes | **yes** | staged behind their answer |
| `coverage` | yes | **yes** | staged behind their answer |
| `remittance_terms` | yes | no | staged — they accept or refuse, cannot counter |
| `shipment_value_ceiling` | yes | no | staged — same |
| `employment` (incl. `employeeRef`) | yes | no | **unilateral, any status** — `PATCH …/employment` |
| `cod.threshold` | via `/cod-limit` | no | **unilateral, any status** |

The two exclusions are deliberate. `employment` is your own internal HR record about that agent —
staging a staff number behind their consent would be theatre. `cod.threshold` is not a term at all
but a sub-allocation of the *agent's* global COD pool, checked transactionally against their
remaining headroom; routing it through a consent inbox would break that allocation race guard.

`remittance_terms` earns their consent for a specific reason: the cadence is now the input to a
**trust penalty** (see [cod-cash-management.md](./cod-cash-management.md)). Tightening `daily` to
`per_delivery` unannounced would start docking an agent's score for cash that was not late under the
terms they signed.

---

### POST /api/agency/agents/:membershipId/counter

**Description**: Write the terms standing on a **pending** contract.

Whether this is a *counter* or a *revision* depends on who is calling, and the difference is
visible in the response:

| Whose terms were standing | This is | `termsProposedBy` after | `awaitingDecisionFrom` after |
|---|---|---|---|
| the agent's | a **counter** | `"agency"` | `"agent"` — the ball moves |
| yours | a **revision** of your own unanswered offer | `"agency"` (unchanged) | `"agent"` (unchanged) |
| nobody's (`null`) | the first proposal | `"agency"` | `"agent"` |

`termsVersion` bumps in all three cases. Revising is allowed on purpose: forcing a withdraw and
re-request to correct a mistyped percentage would destroy the contract row, its history and the
agent's notification thread, for a figure nobody had answered. `termsVersion` is what lets a client
mid-read notice its copy went stale.

**Request Body** — the negotiable groups; at least one required. Same shape as `PATCH …/terms`
minus `employment`:
```json
{
  "fee_split": { "agent_share_percent": 38 },
  "coverage": { "regions": ["littoral", "centre"] }
}
```

**Success Response** (`200 OK`): the updated `AgentMembershipDto`, message *"Terms countered. The
agent must now accept them."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | *(Zod)* | Empty body — at least one term group is required |
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of your country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | Body touched `employment` or another non-negotiated group. `details: { party, offending, negotiable }` |
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or belongs to another agency |
| `409` | `CONTRACT_INVALID_TRANSITION` | Contract is not `pending` — use `/terms-proposals`. `details: { status }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | The patch, **merged over the stored split**, leaves it unable to pay. `details: { model, hint }` |

> The merge is why a partial patch works: switching `model` to `flat` on a contract that already
> carries an `agent_flat_fee` changes one key and is accepted. Switching it on one that does not is
> `422`, because the result could not pay.

---

### POST /api/agency/agents/:membershipId/terms-proposals

**Description**: Propose a change to a **live** contract (`active`, `paused` or `suspended`).

**The contract is not modified.** It keeps pricing deliveries by its agreed terms — the earnings
split goes on dividing by the stored `fee_split` — until the agent accepts. A rejected or unanswered
proposal changes nothing.

At most **one** proposal may be open per contract, enforced by a unique index rather than by a code
path. To replace an open one, `counter` it (keeps the chain) or `cancel` it (ends it).

**Request Body**:
```json
{
  "terms": {
    "remittance_terms": { "cadence": "weekly", "day_of_week": 5, "grace_hours": 48 }
  },
  "note": "Moving the roster to Friday settlement"
}
```

`note` is optional, ≤300 characters, clearable (`""`/`null` → null).

**Success Response** (`201 Created`): a `ContractTermsProposalDto`, message *"Proposal sent. The
current terms stay in force until the agent answers."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of your country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | Non-negotiated group in `terms` |
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or belongs to another agency |
| `409` | `CONTRACT_INVALID_TRANSITION` | Contract is `pending` — counter it instead. `details: { status, allowedFrom }` |
| `409` | `CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING` | One is already open. `details: { proposalId, proposedByRole }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | Merged over the agreed split, it could not pay |

---

### GET /api/agency/agents/:membershipId/terms-proposals

**Description**: That contract's full negotiation trail, newest first — `accepted`, `rejected`,
`withdrawn` and `superseded` rows included, not just the open one. `supersedesId` reconstructs a
counter chain; `termsBefore` on each row is the snapshot taken when it was raised, so an old row
still shows what was actually on the table then.

**Success Response** (`200 OK`): `{ success, data: ContractTermsProposalDto[] }`.

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or belongs to another agency |

---

### GET /api/agency/agents/terms-proposals

**Description**: Every **open** proposal across your roster, in **both** directions — ones the agent
raised that await your answer, and ones you raised that await theirs.

Both directions on purpose: this list is the only place a client learns the id of a proposal it
raised itself, which is what `/cancel` needs. Read `awaitingMyDecision` to tell them apart. **It is
also the correct predicate for a badge count** — counting rows over-counts by every proposal you
raised.

**Success Response** (`200 OK`): `{ success, data: ContractTermsProposalDto[] }`, newest first.

---

### POST /api/agency/agents/terms-proposals/:proposalId/resolve

**Description**: Answer a proposal the **agent** raised.

On `approve` the terms are applied to the contract **inside the same transaction** that marks the
proposal accepted — a proposal recorded as accepted whose terms never landed would leave the two
parties believing different things about what the agent is paid. Coherence is re-checked against the
contract's *current* agreed split, not against `termsBefore`, since the two can diverge via
`/employment` or `/cod-limit` while a proposal sits.

On `reject` the contract is untouched.

**Request Body**: `{ "decision": "approve" | "reject", "note": "string | null" }`

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "proposal": { "...": "ContractTermsProposalDto, state now 'accepted' | 'rejected'" },
    "contract": { "...": "AgentMembershipDto — updated on approve, unchanged on reject" }
  },
  "message": "Terms updated."
}
```

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | You raised it — `/cancel` is your verb. `details: { proposedByRole }` |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or another agency's. **404 not 403** — you must not learn it exists |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved, possibly by a concurrent call. `details: { state }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | The proposal no longer coheres with the contract's current split |

---

### POST /api/agency/agents/terms-proposals/:proposalId/cancel

**Description**: Pull back a proposal **you** raised. The exact inverse of `/resolve`: that one
refuses the author, this one refuses everyone else. The contract is untouched — a withdrawn proposal
never applied anything. Cancelling frees the one-open-proposal slot.

**Request Body**: `{ "note": "string | null" }`

**Success Response** (`200 OK`): the `ContractTermsProposalDto`, `state: "withdrawn"`.

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | The agent raised it — `/resolve` is your verb |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or another agency's |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |

---

### POST /api/agency/agents/terms-proposals/:proposalId/counter

**Description**: Supersede the agent's open proposal with your own, in one transaction.

**Distinct from `/resolve` with `"reject"`.** A rejection ends the negotiation; a counter keeps it
alive and records the chain — the old row becomes `superseded` (not `rejected`, which would be a
lie), and the new one carries `supersedesId` pointing back at it. That is what makes a multi-round
negotiation reconstructible after the fact.

**Request Body**: `{ "terms": { … }, "note": "string | null" }`

**Success Response** (`201 Created`): the **new** `ContractTermsProposalDto`, message
*"Counter-proposal sent. The agent must now answer it."*

| Status | Code | Description |
|--------|------|-------------|
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of your country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | Non-negotiated group in `terms` |
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | You raised it — cancel it and raise another instead |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or another agency's |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | Merged over the agreed split, it could not pay |

---

`availableActions` on every `ContractTermsProposalDto` lists exactly the verbs the server will accept
from that viewer, in render order. Drive the UI from it and a client never renders a button that
403s.

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | Answering your own proposal, or cancelling someone else's |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or belongs to another agency (404 rather than 403 — you must not learn it exists) |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |
