# Agency Memberships (Agent-Facing)

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required.

```
Authorization: Bearer <access_token>
```

Every endpoint is scoped to the calling agent. A contract that is not yours reports `404`, never
`403`.

## Overview

Symmetric counterpart to [Agency: Agent Roster](../agency/agent-roster.md) — **read that doc first**
for the full status lifecycle (`pending → active/rejected/withdrawn`, `active ⇄ paused/suspended`,
`→ deactivated`), the two-party status-request machinery, the COD sub-allocation rule and the
`AgentMembershipDto` field reference. This doc covers the agent side: finding agencies, sending and
answering requests, and managing the contracts you hold.

You sign up independently (see [onboarding.md](./onboarding.md)) and are **not** attached to any
agency at first. You may serve **several at once** — each relationship is a separate contract with
its own status, employment terms, fee split and COD slice.

### The handshake

Two ways in, and they are symmetric: both land in `pending`, and in both the party who did *not*
raise the request answers it.

| Path | Raised by | Answered by | Raiser may |
|---|---|---|---|
| **An agency approaches you** | the agency | **you** — `POST /memberships/:id/approve` or `/reject` | they withdraw |
| **You apply** | **you** — `POST /memberships/requests` | the agency | `POST /memberships/:id/withdraw` |

Read `initiatedBy` (`agent` \| `agency`) on the contract to know which pair of buttons applies.
**Calling the wrong verb is a `403`** — the initiator may only withdraw, the counterparty may only
approve/reject. The four verbs (`approve`, `reject`, `withdraw`, `terminate`) mean the same thing
here, on the agency's router, and in the vendor↔agency flow.

> **Email invites are gone.** `GET /api/agent/invites` and `POST /api/agent/invites/:id/accept` no
> longer exist. An agency's request is simply a `pending` contract, so it reaches you through
> `GET /api/agent/memberships?status=pending` like everything else — and through a notification
> (`agent_contract.request_received`), which is now the signal that something is waiting.

### Rules

- At most **one live contract per agency**, and at most `AGENT_MAX_AGENCY_RELATIONSHIPS`
  (default 5) allocating contracts in total.
- Exactly one `active` contract is your **primary** agency. The first you join becomes primary
  automatically; you can change it. If your primary is deactivated, another active one is promoted.
- You must be **KYC-verified and not platform-banned** to raise or accept any contract, and you only
  appear in the agency directory once you are. Both are admin-set — see [profile.md](./profile.md).
- The gates are re-checked **when a request is approved**, not when it was raised. A request may
  always be created; it is approval that binds.
- **Leaving needs both parties to agree**, and is blocked while you hold that agency's undeposited
  COD cash or are still owed wages under that contract — see [cod-cash.md](./cod-cash.md). Both are
  scoped to the one contract: cash you owe agency A never blocks leaving agency B.

### Coverage regions are PICKED, not typed

> 🆕 **Changed 2026-08-06 — UI change required.** `coverage.regions` used to be a free-text list.
> It is now a **region picker**, over the same catalogue an agency uses for its own coverage areas,
> and a value that is not a region of the agency's country is rejected. Replace the text input on
> your terms form with a multi-select. No endpoint, path or field name changed.

Coverage is one of your **two levers** (with `fee_split`), so this affects every terms body you
send: `POST /memberships/requests`, `POST /memberships/:id/counter`,
`POST /memberships/:id/terms-proposals` and `…/terms-proposals/:proposalId/counter`.

**The catalogue is the AGENCY's country**, not yours — you are agreeing where you will work *for
them*. Two fields tell you what to render, and both are on the contract payloads
(`GET /api/agent/memberships`, `GET /api/agent/memberships/:id`) as well as on the directory row
(`GET /api/agent/agencies/browse`, as `country` + `coverageAreas`):

| Field | Use |
|---|---|
| `agencyCountry` | ISO-2 (`"CM"`). **Scopes the picker** — offer that country's regions from `locations.json`. `null` on a legacy agency: no catalogue, so fall back to free text (the server skips the check too) |
| `agencyCoverageAreas` | The regions the agency itself declares it serves. **A hint, not a bound** — mark them ("agency covers this"), but let the picker offer the rest of the country too |

You may agree a region the agency has not declared: agencies contract agents for regions they are
expanding into before they declare them.

| Sent | Stored | Why |
|---|---|---|
| `"littoral"` | `littoral` | already a key |
| `"Littoral"` / `" LITTORAL "` | `littoral` | case and padding are forgiving |
| `"Extrême-Nord"` / `"Far North"` | `far_north` | localized names resolve to their key |
| `"Douala"` | — **`400`** | a city is not a region |
| `"Litoral"` | — **`400`** | a typo resolves to nothing |

`400 CONTRACT_COVERAGE_REGION_INVALID` carries
`details: { invalid: string[], requiredCountry: "CM", allowedRegions: string[] }` — `allowedRegions`
is the whole catalogue, so you can repair a stale picker from the error itself.

**`regions: []` means you work everywhere the agency does — not nowhere.** It is the default on
every contract; label the empty state "All regions". Contracts written before this change may still
hold free text; render what you receive, and send keys back on the next save.

### What you may drive

| Change | You may | The agency may |
|---|---|---|
| approve / reject a **pending** contract | on your own — only if the **agency** raised it | only if **you** raised it |
| withdraw a **pending** contract | on your own — only if **you** raised it | only if they raised it |
| pause | needs the agency's agreement | on its own |
| reactivate | needs the agency's agreement | on its own |
| suspend | **never** — going offline is what `availability` is for | on its own |
| **terminate** | **needs their agreement** | needs yours |

Anything needing agreement raises a **`ContractStatusRequest`** rather than moving the contract; it
waits in the counterparty's inbox. You can never resolve a request you raised.

---

## Endpoints

### GET /api/agent/agencies/browse

**Description**: The agency directory — how you find agencies to apply to. Only agencies open for
business are listed (active, onboarding complete). Each result is annotated with your current
contract state, so the UI can render Apply / Pending / Connected.

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | — | Name, coverage areas, HQ city/region/address |
| `region` | string | — | Matches a coverage area |
| `hq_city` | string | — | Matches the primary HQ city |
| `page` | integer | `1` | |
| `limit` | integer | `20` | Max 100 |

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "logo": { "id": "665f...", "key": "images/2026/07/logo.png", "url": "https://cdn.example.com/logo.png", "mimeType": "image/png", "size": 8213, "originalName": "logo.png" },
      "kycVerified": true,
      "headquartersAddress": { "region": "Littoral", "city": "Douala", "address_description": "Akwa, Rue Joss" },
      "country": "CM",
      "coverageAreas": ["littoral", "centre"],
      // The agency's service rating, from its CUSTOMERS' delivery reviews.
      // `null` when nobody has rated them — never `0`. Show the count beside it.
      // See ../reviews.md.
      "rating": 4.6,
      "ratingCount": 38,
      "policies": { "pricing": { "storage_based_enabled": true, "pickup_based_enabled": true, "notes": null }, "returns": { "payer": "vendor", "return_window_days": 7, "notes": null }, "damage": { "claim_deadline_days": 5, "max_refund_per_item": 50000, "notes": null } },
      "contract": null
    }
  ],
  "meta": { "total": 12, "page": 1, "limit": 20, "totalPages": 1 }
}
```

`contract` is `null` when you have no history with the agency, otherwise
`{ id, status, initiatedBy, isPrimary }` — your **live** contract if there is one, else the most
recent terminal one.

`country` (ISO-2, `null` on legacy agencies) and `coverageAreas` are what a **coverage picker** on
the apply form needs: the first scopes the region catalogue, the second marks which of those regions
the agency actually serves. See
[Coverage regions are picked, not typed](#coverage-regions-are-picked-not-typed).

> **Your commission is not here.** `fee_split` is negotiated per contract, so there is nothing to
> show until one exists. The `policies` block is the agency's *vendor-facing* terms (pricing model,
> returns, damage) — useful context for how they operate, not terms that bind you.

---

### POST /api/agent/memberships/requests

**Description**: Apply to an agency. Creates a `pending` contract.

`terms` is **optional**, and the asymmetry with the agency's request (where it is required) is
deliberate — you may state an asking rate, or apply bare and let them propose.

**Request Body** — bare:
```json
{ "agencyId": "507f1f77bcf86cd799439099" }
```

**Request Body** — stating your terms:
```json
{
  "agencyId": "507f1f77bcf86cd799439099",
  "terms": {
    "fee_split": { "model": "percentage", "agent_share_percent": 45, "currency": "XAF" },
    "coverage": { "regions": ["littoral"] }
  }
}
```

You may only state **your own two levers** — `fee_split` and `coverage`. The remittance cadence, the
value ceiling and the COD limit are the agency's risk controls: you answer them, you do not write
them. Anything else in `terms` is a `403 CONTRACT_TERMS_NOT_NEGOTIABLE`.

If you state terms at all, `fee_split` is required — coverage alone would leave your own proposal
carrying a null share, i.e. a cut of **zero**, which the agency then could not approve. Omit `terms`
entirely to say "your terms, whatever they are".

**Success Response** (`201 Created`): an `AgentMembershipDto`, `status: "pending"`,
`origin: "join_request"`, `initiatedBy: "agent"`.

| Sent | `termsProposedBy` | `awaitingDecisionFrom` | What happens next |
|---|---|---|---|
| with `terms` | `"agent"` | `"agency"` | They accept, reject, or counter |
| bare | `null` | `null` | **They must propose terms before anyone can approve.** Their control reads *Propose terms*, not *Approve* |

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of the agency's country. `details: { invalid, requiredCountry, allowedRegions }` |
| `404` | `DELIVERY_AGENCY_NOT_FOUND` | `agencyId` does not resolve to an agency |
| `409` | `AGENT_MEMBERSHIP_ALREADY_EXISTS` | You already have a live contract with them. `details: { status, contractId }` |
| `422` | `AGENT_KYC_NOT_VERIFIED` | `details: { kycStatus, hint }` |
| `403` | `AGENT_PLATFORM_BANNED` | |

> Deliberately **not** blocked by your relationship cap or COD headroom — a request may always be
> raised, and it is approval that binds. Refusing here would hide the queue from the agency and
> leave you nothing to point at when you raise your threshold.

---

### GET /api/agent/memberships

**Description**: Your agency portfolio. **Every status by default**, terminal rows included — this
is your relationship history, not only where you work today.

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | One of `pending` \| `active` \| `paused` \| `suspended` \| `rejected` \| `withdrawn` \| `deactivated`. Omitted returns **all** |
| `page` | integer | `1` | |
| `limit` | integer | `20` | Max 100 |

**Success Response** (`200 OK`): an array of `AgentMembershipDto` each carrying three extra
counterparty fields — `agencyName`, `agencyCountry`, `agencyCoverageAreas` — plus `meta`.

```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439300",
      "agentId": "507f1f77bcf86cd799439011",
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "agencyCountry": "CM",
      "agencyCoverageAreas": ["littoral", "centre"],
      "status": "active",
      "origin": "join_request",
      "initiatedBy": "agent",
      "isPrimary": true,
      "employment": { "employmentType": "contractor", "employeeRef": null, "startedAt": null, "endsAt": null },
      "remittanceTerms": { "cadence": "daily", "dayOfWeek": null, "dayOfMonth": null, "graceHours": 24 },
      "coverage": { "regions": ["littoral"], "area": null },
      "feeSplit": { "model": "percentage", "agentSharePercent": 70, "agentFlatFee": null, "currency": "XAF" },
      "shipmentValueCeiling": null,
      "codThreshold": 200000,
      "codOutstandingBalance": 45000,
      "invitedAt": null,
      "requestedAt": "2026-01-04T09:00:00.000Z",
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
    }
  ],
  "meta": { "total": 3, "page": 1, "limit": 20, "totalPages": 1 }
}
```

Field meanings are in the
[canonical reference](../agency/agent-roster.md#agentmembershipdto). Three worth restating:

- `feeSplit` is **your cut of that agency's delivery fee** — the same numbers
  [earnings.md](./earnings.md) divides by, both for an offer's estimate and for the actual at
  delivery. Only the agency writes it (`PATCH …/terms` on their side); you read it here. The other
  negotiated terms travel with it: `remittanceTerms` (how often you settle their cash),
  `coverage` (the zone this contract covers) and `shipmentValueCeiling` (the most one shipment may
  be worth under it, `null` = uncapped).
- `codThreshold` is **that agency's** slice of your global COD pool (minor units), not an
  independent cap. It is a `number` defaulting to `0` — `0` means they have granted you no COD
  headroom at all. The sum across your allocating contracts can never exceed your own
  `cod.max_threshold`; see [cod-cash.md](./cod-cash.md).
- `removedAt` / `removalReason` are the **termination** stamps; the field names predate the
  `deactivated` status.

---

### GET /api/agent/memberships/:membershipId

**Description**: One contract, with the agency's business surface resolved.

**Success Response** (`200 OK`): a single `AgentMembershipDto` + `agencyName`, `agencyCountry` and
`agencyCoverageAreas`, same shape as a row above. **This is the payload a terms editor renders
from** — the last two are what its coverage picker needs.

**Error Responses**: `404 CONTRACT_NOT_FOUND` — unknown, or not yours.

---

### POST /api/agent/memberships/:membershipId/approve

**Description**: Accept **the terms currently standing** on a pending contract. → `active`; the
agency can assign you shipments (and COD collections) from that moment.

You may only approve when `awaitingDecisionFrom` is `"agent"` — i.e. the *agency's* terms are the
ones on the table. If you countered last, they answer, not you.

**Success Response** (`200 OK`): the contract, `status: "active"`, message *"You have joined the
agency."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | **Your** terms are the ones standing — withdraw them, don't approve them. `details: { transition, party, proposer, hint }` |
| `422` | `CONTRACT_TERMS_NOT_PROPOSED` | **Nobody has proposed terms yet.** You applied bare (or this is a legacy contract) — the agency must propose before anyone can approve. `details: { contractId, hint }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | The standing terms could not pay you — a `percentage` model with no share resolves to a cut of **zero**. Refused rather than agreed to |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more. `details: { from, allowedFrom }` |
| `422` | `AGENT_KYC_NOT_VERIFIED` | Platform gates are re-checked **here** |
| `403` | `AGENT_PLATFORM_BANNED` | Likewise |
| `422` | `AGENT_MEMBERSHIP_LIMIT_REACHED` | Too many agencies. `details: { current, max }` |
| `422` | `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | The COD slice does not fit your pool |

> **Guard order matters when reading a failure.** Terms are checked *before* KYC and the COD pool, so
> `CONTRACT_TERMS_NOT_PROPOSED` on a contract you expected to accept means exactly what it says — the
> agency owes you an offer — and not that something is wrong with your account.

---

### POST /api/agent/memberships/:membershipId/reject

**Description**: Refuse a request an **agency** raised. → `rejected` (terminal).

**Request Body**: `{ "reason": "Outside my service radius" }` — optional, ≤300 chars.

**Error Responses**: as `/approve` for `404` / `403` / `409`.

---

### POST /api/agent/memberships/:membershipId/withdraw

**Description**: Pull back an application **you** raised, while still `pending`. → `withdrawn`
(terminal). You may apply to the same agency again afterwards; that creates a new contract.

**Request Body**: `{ "reason": "Changed my mind" }` — optional, ≤300 chars.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | The **agency** raised this one — `reject` it instead |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more |

---

### POST /api/agent/memberships/:membershipId/terminate

**Description**: Propose ending an established contract.

**This proposes; it does not perform.** Unlike the vendor↔agency `terminate`, ending an
agent↔agency contract is **not** unilateral — cash and wages are why. It raises a
`ContractStatusRequest` for the agency to clear, and `membership` is `null` until they do.

**Request Body**: `{ "reason": "Moving cities" }` — optional, ≤300 chars.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "507f1f77bcf86cd799439055",
      "contractId": "665f1f77bcf86cd799439300",
      "transition": "deactivate",
      "targetStatus": "deactivated",
      "fromStatus": "active",
      "state": "pending",
      "requestedByRole": "agent",
      "blockingConditions": { "outstandingCod": 45000, "outstandingPayment": 0, "clear": false }
    },
    "membership": null
  },
  "message": "Termination proposed. It takes effect once the agency agrees and nothing is outstanding."
}
```

`blockingConditions` is advisory — the same conditions are re-checked at approval, never trusted
from when the request was raised.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `409` | `CONTRACT_STATUS_REQUEST_ALREADY_PENDING` | One open termination per contract. `details: { requestId }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | Already terminal |
| `422` | `CONTRACT_HAS_OUTSTANDING_COD` | On approval — you must deposit that agency's cash first. `details: { outstandingCod, hint }` |
| `422` | `CONTRACT_HAS_UNPAID_EARNINGS` | On approval — they must pay you first. `details: { outstandingPayment, hint }` |

---

### POST /api/agent/memberships/:membershipId/transitions

**Description**: The two lifecycle changes with no named endpoint of their own. Ending a contract is
`/terminate` above, **not** a transition here.

**Request Body**:
```json
{ "transition": "pause", "reason": "Travelling for a month" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `transition` | string | ✅ | `pause` or `reactivate` |
| `reason` | string \| null | ❌ | ≤300 chars |

Both need the agency's agreement, so the response carries `membership: null` until they resolve it.

**Success Response** (`201 Created`): `{ "request": ContractStatusRequestDto, "membership": null }`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | `VALIDATION_ERROR` | `transition` is not `pause` or `reactivate` — the handshake verbs and `deactivate` have their own endpoints |
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | `suspend` is never yours to raise. `details: { transition, party }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | Wrong starting status. `details: { transition, from, allowedFrom }` |
| `409` | `CONTRACT_STATUS_REQUEST_ALREADY_PENDING` | `details: { requestId }` |

---

### PUT /api/agent/memberships/:membershipId/primary

**Description**: Set this contract's agency as your default. Exactly one `active` contract is
primary at a time.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `409` | `AGENT_MEMBERSHIP_NOT_APPROVED` | Only an **`active`** contract can be primary. `details: { status }`. The code name predates the status rename |

---

### GET /api/agent/memberships/status-requests

**Description**: Every **pending** contract change on you, newest first — most often a termination.

**Both directions appear here, and that is required, not incidental.** The query filters on you and
on `pending`, nothing else, so the list carries the changes an agency raised that await *your*
consent **and** the ones you raised that await *theirs*. This endpoint is the **only** place a
`requestId` is exposed, so dropping the rows you raised would leave `/cancel` uncallable.

**Read `awaitingMyDecision`, don't count rows.** It is `true` only on rows that are yours to answer,
and `availableActions` names the verbs you may call:

| `requestedByRole` | `awaitingMyDecision` | `availableActions` | Render |
|---|---|---|---|
| `agency` | `true` | `["approve","reject"]` | "They want to end your contract — Approve / Reject" |
| `agent` | `false` | `["cancel"]` | "You asked to leave — Cancel" |

Both fields are computed server-side from the same rule the service guards enforce, so a button this
DTO offers is one the service will accept. Use `awaitingMyDecision` for an unread badge — counting
rows over-counts by every request you raised yourself, and rendering a self-raised row as "Approve"
produces a `403 CONTRACT_STATUS_REQUEST_NOT_YOURS` on click.

Named `status-requests`, not `requests`: `POST /memberships/requests` already means "apply to an
agency", which is the opposite direction.

**Success Response** (`200 OK`): an array of `ContractStatusRequestDto`.

---

### POST /api/agent/memberships/status-requests/:requestId/resolve

**Description**: Approve or reject a request the agency raised.

**Request Body**:
```json
{ "decision": "approve", "note": "Agreed" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `decision` | string | ✅ | `approve` or `reject` |
| `note` | string \| null | ❌ | ≤300 chars |

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_STATUS_REQUEST_NOT_YOURS` | You raised it; the agency must resolve it |
| `404` | `CONTRACT_STATUS_REQUEST_NOT_FOUND` | Unknown, or not addressed to you |
| `409` | `CONTRACT_STATUS_REQUEST_NOT_PENDING` | Already resolved. `details: { state }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | The contract moved since the request was raised |
| `422` | `CONTRACT_HAS_OUTSTANDING_COD` / `CONTRACT_HAS_UNPAID_EARNINGS` | On approving a termination while either side still owes the other |

---

### POST /api/agent/memberships/status-requests/:requestId/cancel

**Description**: Pull back a still-pending request **you** raised — a pause, a reactivation, or a
departure you have changed your mind about. The exact inverse of `/resolve`: that one answers the
agency's requests, this one withdraws your own.

**The contract is untouched.** A cancelled request never moved it, so there is nothing to undo and
nothing to settle: outstanding COD and unpaid earnings gate *ending* a contract, not abandoning a
proposal to end one. Consequently there is no `422` here, and `membership` is always `null`.

Cancelling frees the per-(contract, transition) pending slot, so you may raise the same transition
again afterwards. It appends no membership-history event — a cancelled request moved no state, and
the request row's own `state` / `resolvedByRole` / `resolvedAt` is the complete trail.

**Request Body** (optional):
```json
{ "note": "Changed my mind, staying on" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `note` | string \| null | ❌ | ≤300 chars. Stored as `resolutionNote` |

**Success Response** (`200 OK`): same shape as `/resolve` —
`{ request: ContractStatusRequestDto, membership: null }`, with `request.state` now `cancelled`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_STATUS_REQUEST_NOT_YOURS` | The **agency** raised it — answer it with `/resolve` instead. `details: { requestedByRole, hint }` |
| `404` | `CONTRACT_STATUS_REQUEST_NOT_FOUND` | Unknown, or not addressed to you |
| `409` | `CONTRACT_STATUS_REQUEST_NOT_PENDING` | Already resolved. `details: { state }`. This is also what a cancel racing the agency's approval returns to the loser — the write is a compare-and-set on `pending`, so exactly one of the two wins |

---

### GET /api/agent/memberships/:membershipId/settlements

**Description**: Cash and wages outstanding with **this** agency — the per-contract view that
decides whether a termination can complete. `GET /api/agent/cod/balance` answers your total across
every agency; this answers "am I square with *them*?".

**Query Parameters**: `page` (default 1), `limit` (default 20, max 100).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "membershipId": "665f1f77bcf86cd799439300",
    "cod": { "threshold": 200000, "outstandingBalance": 45000, "lifetimeSettled": 1250000, "lastSettledAt": "2026-07-26T17:30:00.000Z" },
    "payment": { "outstandingToAgent": 12000, "lifetimePaid": 340000, "lastPaidAt": "2026-07-20T10:00:00.000Z" },
    "deposits": []
  },
  "meta": { "total": 12, "page": 1, "limit": 20 }
}
```

**Error Responses**: `404 CONTRACT_NOT_FOUND`.

---

### GET /api/agent/memberships/history

**Description**: Your full contract trail across every agency, newest first.

**Event types**: see the
[canonical list](../agency/agent-roster.md#get-apiagencyagentshistory). `invited` is what an agency
raising a request records; the `invite_*` types appear only on historical rows from the removed
email-invite subsystem.

---

## Response Field Reference & TypeScript Reference

Identical to the agency's view of the same contract. See
[Agency: Agent Roster § Response Field Reference](../agency/agent-roster.md#response-field-reference)
for the full `AgentMembershipDto`, `ContractStatusRequestDto` and `ContractTermsProposalDto`, and the
TypeScript block beneath it.

**The three fields that decide your UI**, repeated here because they are the ones agent clients get
wrong:

| Field | Type | Use |
|---|---|---|
| `awaitingDecisionFrom` | `"agent" \| "agency" \| null` | `"agent"` → show Accept / Reject / Counter. `"agency"` → show Withdraw only. `null` → no offer on the table (see below) |
| `termsProposedBy` | `"agent" \| "agency" \| null` | `null` means nobody has proposed terms; on a pending contract that means **you are waiting for the agency to make an offer** |
| `termsVersion` | number | Bumps on every counter and revision. If it moved since you rendered, your copy of the offer is stale — re-fetch before acting |

> `initiatedBy` is **not** the button rule any more. It still reports who opened the relationship,
> but after a counter the right to approve moves and `initiatedBy` does not — driving buttons from it
> shows Accept to whoever just made the offer.

Your views add three counterparty fields:

```typescript
interface AgentMembershipWithAgencyDto extends AgentMembershipDto {
  /** The agency's business name, resolved from their Magazin. null if unset. */
  agencyName: string | null;
  /**
   * ISO-2 country of the agency — the catalogue `coverage.regions` is validated
   * against, and what a coverage picker must be scoped to. null on a legacy
   * agency with no country on file, where the server skips the check.
   */
  agencyCountry: string | null;
  /**
   * The regions the agency declares it serves. A HINT for the picker (mark
   * them), never a bound — a contract may name any region of `agencyCountry`.
   */
  agencyCoverageAreas: string[];
}
```

The agency-directory row returned by `GET /agencies/browse` is the same
`VendorAgencyListItemDto` the vendor flow uses — see
[Vendor: Agency Connections](../vendor/agency-connections.md#response-field-reference) — plus the
`contract` annotation described above.

---

## Usage Examples

```
GET   /api/agent/agencies/browse?search=douala&region=littoral
POST  /api/agent/memberships/requests                  { "agencyId": "507f..." }
POST  /api/agent/memberships/requests                  { "agencyId": "507f...", "terms": { "fee_split": { "model": "percentage", "agent_share_percent": 45 } } }
GET   /api/agent/memberships?status=pending
GET   /api/agent/memberships/665f...
POST  /api/agent/memberships/665f.../approve
POST  /api/agent/memberships/665f.../reject            { "reason": "Too far" }
POST  /api/agent/memberships/665f.../withdraw
POST  /api/agent/memberships/665f.../counter           { "fee_split": { "agent_share_percent": 45 } }
POST  /api/agent/memberships/665f.../terminate         { "reason": "Moving cities" }
POST  /api/agent/memberships/665f.../transitions       { "transition": "pause" }
PUT   /api/agent/memberships/665f.../primary
GET   /api/agent/memberships/status-requests
POST  /api/agent/memberships/status-requests/778a.../resolve  { "decision": "approve" }
POST  /api/agent/memberships/status-requests/778a.../cancel   { "note": "Changed my mind" }
POST  /api/agent/memberships/665f.../terms-proposals   { "terms": { "coverage": { "regions": ["littoral"] } }, "note": "Dropping Centre" }
GET   /api/agent/memberships/665f.../terms-proposals
GET   /api/agent/memberships/terms-proposals
POST  /api/agent/memberships/terms-proposals/99ab.../resolve  { "decision": "reject", "note": "Can't work at that rate" }
POST  /api/agent/memberships/terms-proposals/99ab.../counter  { "terms": { "fee_split": { "agent_share_percent": 42 } } }
POST  /api/agent/memberships/terms-proposals/99ab.../cancel   { "note": "Withdrawing" }
```

### Two ways to apply, and what follows

```
# A. Bare — you take whatever they offer.
POST /api/agent/memberships/requests   { "agencyId": "507f..." }
  → 201  termsProposedBy: null, awaitingDecisionFrom: null
         "Request sent. The agency will propose terms for you to review."
  → you CANNOT approve yet: 422 CONTRACT_TERMS_NOT_PROPOSED
  → they propose  →  awaitingDecisionFrom: "agent"  →  you approve / reject / counter

# B. Stating your rate — they answer you.
POST /api/agent/memberships/requests
     { "agencyId": "507f...", "terms": { "fee_split": { "model": "percentage", "agent_share_percent": 45 } } }
  → 201  termsProposedBy: "agent", awaitingDecisionFrom: "agency"
         "Request sent with your terms. The agency will accept, reject or counter them."
  → they counter at 38  →  awaitingDecisionFrom: "agent", termsVersion: 2
  → you accept          →  status: "active"
```

At any point while `awaitingDecisionFrom` is `"agency"`, `POST …/withdraw` is yours — you are never
locked into an offer you made.

---

## Notifications

Eight agent-facing situations, all gated on the `contractUpdated` preference
(see [notifications.md](./notifications.md)).

The handshake that **forms** a contract:

- `agent_contract.request_received` — an agency wants you to deliver for them. **This is now the
  only signal** that a request is waiting; there is no invite inbox to poll.
- `agent_contract.approved` — an agency approved your application.
- `agent_contract.rejected` — an agency declined your application.

Changes to a contract that **already exists** — the status-request inbox above:

- `agent_contract.status_request_raised` — an agency proposed a change that needs your answer: a
  pause, a reactivation, or ending the contract. Fires only for transitions that actually stay
  pending; a `unilateral` one self-clears and never waits on anyone.
- `agent_contract.status_request_resolved` — a pending change was approved, declined, or cancelled.
  It covers both "the agency answered what you raised" and "the agency withdrew what you were
  waiting on", so the copy names the change rather than whose request it was.

Changes to the **terms** — what you are paid and where you work:

- `agent_contract.terms_countered` — the agency changed the terms of a **pending** contract. The
  right to accept is now yours. Without this an agent who thinks their own offer is still standing
  never goes back to look.
- `agent_contract.terms_proposed` — the agency wants to change a **live** contract. The copy says
  **your current terms stay in force until you answer**, and that is a fact rather than a
  reassurance: nothing changes unless you accept, and you keep being paid the agreed rate while the
  proposal sits.
- `agent_contract.terms_resolved` — a proposal was accepted, declined, withdrawn or superseded.
  Neutral about whose it was, since it covers both "the agency answered yours" and "the agency
  withdrew the one you were waiting on".

Each carries `contractId` and `agencyName`, and deep-links to `memberships/{{contractId}}`; the two
`status_request_*` events also carry `requestId`, `transition` and `state`, and are made idempotent
on the **request** id. The `terms_proposed`/`terms_resolved` pair carries `proposalId`,
`proposedByRole`, `state` and `changedTerms`, and is idempotent on the **proposal** id;
`terms_countered` is idempotent on the contract id **plus emission time**, so a multi-round
negotiation notifies once per round rather than only once.

All eight event names are consumed by the **agency** stack with different copy; a `recipientRole`
discriminator decides whose they are. See
[the agency's side](../agency/agent-roster.md#notifications).

> **WhatsApp is dark for the three new situations** until `agent_contract_terms_countered`,
> `_terms_proposed` and `_terms_resolved` exist in Meta Business Manager. In-app, email, Telegram
> and push work today.

---

## Terms negotiation

> Canonical reference: [Agent Roster § Terms negotiation](../agency/agent-roster.md#terms-negotiation).
> This section documents the agent's endpoints; the lifecycle and error catalogue live there.

**Your two levers are `fee_split` and `coverage`** — what you are paid, and where you will work.
Everything else on the contract is the agency's to write; you accept or refuse it. A body touching
`remittance_terms`, `shipment_value_ceiling` or `employment` is `403 CONTRACT_TERMS_NOT_NEGOTIABLE`.

**Read `awaitingDecisionFrom`, not `initiatedBy`, to decide which buttons to render.** `initiatedBy`
still reports who opened the relationship, but it is audit now: after a counter the right to approve
moves and `initiatedBy` does not. `awaitingDecisionFrom: "agent"` means the offer is yours to answer
(Accept / Reject / Counter); `"agency"` means you are waiting on them and your only move is
Withdraw; `null` means nobody may approve yet — either the contract is not pending, or no terms have
been proposed at all.

### What you may write, and what you only answer

| Term group | You may propose | Meaning |
|---|---|---|
| `fee_split` | **yes** | Your cut per delivery — percentage of the delivery fee, or a flat amount |
| `coverage` | **yes** | The regions you will work under this contract — **picked** from the agency's country, see [above](#coverage-regions-are-picked-not-typed) |
| `remittance_terms` | no | How often you settle their COD cash, and the grace period. You accept or refuse |
| `shipment_value_ceiling` | no | The most they will trust you with in one parcel. You accept or refuse |
| `employment` | no | Their internal HR record about you |
| COD threshold | no | Your slice of their cash risk — `PATCH /cod-limit`, agency-only |

Anything outside your two levers is `403 CONTRACT_TERMS_NOT_NEGOTIABLE`, with
`details: { party, offending, negotiable }` naming exactly which group was refused.

> You are never trapped by your own offer. Whoever's terms are standing may always `withdraw`;
> whoever's are not may always `approve`, `reject` or counter back. That holds at every step of a
> negotiation however long it runs.

---

### POST /api/agent/memberships/:membershipId/counter

**Description**: Counter the terms standing on a **pending** contract, moving the decision to the
agency.

**Request Body** — at least one group required:
```json
{
  "fee_split": { "model": "percentage", "agent_share_percent": 45 },
  "coverage": { "regions": ["littoral"] }
}
```

**Success Response** (`200 OK`): the updated `AgentMembershipDto` — `termsProposedBy: "agent"`,
`termsVersion` bumped, `awaitingDecisionFrom: "agency"`. Message *"Terms countered. The agency must
now accept them."*

Calling this when **your** terms are already standing is a *revision*, not a counter: allowed, the
version bumps, and the decision stays with the agency. Nothing was answered, so nothing moves.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | *(Zod)* | Empty body — at least one of `fee_split` / `coverage` |
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of the agency's country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | You touched a group that is not yours to write |
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `409` | `CONTRACT_INVALID_TRANSITION` | Contract is not `pending` — use `/terms-proposals`. `details: { status }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | Merged over the stored split, it could not pay — e.g. switching to `flat` on a contract with no flat fee set |

---

### POST /api/agent/memberships/:membershipId/terms-proposals

**Description**: Propose a change to a **live** contract — asking for a raise, or dropping a region.

**Your current terms stay in force until the agency answers.** The proposal changes nothing on its
own: you go on being paid the agreed rate while it sits, and a rejected or ignored one leaves you
exactly where you were. At most one proposal may be open per contract.

**Request Body**:
```json
{
  "terms": { "fee_split": { "agent_share_percent": 45 } },
  "note": "Taking on the Bonabéri route as well"
}
```

**Success Response** (`201 Created`): a `ContractTermsProposalDto`, message *"Proposal sent. Your
current terms stay in force until the agency answers."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of the agency's country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | A group outside your two levers |
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `409` | `CONTRACT_INVALID_TRANSITION` | Contract is `pending` — counter it instead. `details: { status, allowedFrom }` |
| `409` | `CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING` | One is already open on this contract. `details: { proposalId, proposedByRole }` |
| `422` | `CONTRACT_FEE_SPLIT_INVALID` | Merged over the agreed split, it could not pay |

---

### GET /api/agent/memberships/:membershipId/terms-proposals

**Description**: That contract's negotiation trail, newest first — `accepted`, `rejected`,
`withdrawn` and `superseded` rows included, not only the open one.

Each row carries `termsBefore` (snapshotted when it was raised, so it still shows what was actually
on the table then), `proposedTerms`, and a flattened `diff` of one entry per changed leaf. This is
the record of what you were offered and when.

**Success Response** (`200 OK`): `{ success, data: ContractTermsProposalDto[] }`.

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |

---

### GET /api/agent/memberships/terms-proposals

**Description**: Every **open** proposal across all your contracts, in **both** directions.

Both directions on purpose: this is the only place a client learns the id of a proposal *you* raised,
which `/cancel` needs. `awaitingMyDecision` separates "the agency wants your answer" from "you are
waiting on theirs", and is the correct predicate for a badge — the raw row count includes your own.

**Success Response** (`200 OK`): `{ success, data: ContractTermsProposalDto[] }`, newest first.

---

### POST /api/agent/memberships/terms-proposals/:proposalId/resolve

**Description**: Answer a proposal the **agency** raised. `{ "decision": "approve" | "reject",
"note": "string | null" }`.

On `approve` the new terms are applied to the contract in the same transaction that marks the
proposal accepted — from that moment your deliveries are priced by them. On `reject` nothing changes
and your existing terms continue.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "proposal": { "...": "ContractTermsProposalDto" },
    "contract": { "...": "AgentMembershipDto — updated on approve, unchanged on reject" }
  }
}
```

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | You raised it — `/cancel` is your verb |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or not on one of your contracts |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |

---

### POST /api/agent/memberships/terms-proposals/:proposalId/cancel

**Description**: Withdraw a proposal **you** raised. `{ "note": "string | null" }`. The contract is
untouched, and the one-open-proposal slot is freed so you may raise another.

| Status | Code | Description |
|--------|------|-------------|
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | The agency raised it — `/resolve` is your verb |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or not yours |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |

---

### POST /api/agent/memberships/terms-proposals/:proposalId/counter

**Description**: Supersede the agency's open proposal with your own, in one transaction.
`{ "terms": { … }, "note": "string | null" }`.

Different from rejecting: a rejection ends the conversation, a counter keeps it going. Their row
becomes `superseded` and yours carries `supersedesId` pointing back at it.

**Success Response** (`201 Created`): the **new** `ContractTermsProposalDto`.

| Status | Code | Description |
|--------|------|-------------|
| `400` | `CONTRACT_COVERAGE_REGION_INVALID` | A `coverage.regions` entry is not a region of the agency's country. `details: { invalid, requiredCountry, allowedRegions }` |
| `403` | `CONTRACT_TERMS_NOT_NEGOTIABLE` | A group outside your two levers |
| `403` | `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | You raised it — cancel it and raise another |
| `404` | `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | Unknown, or not yours |
| `409` | `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | Already resolved. `details: { state }` |

> **`availableActions` tells you which of these three applies**, per proposal, without you deriving
> it. A proposal that changes only the remittance cadence offers `approve` and `reject` but **not**
> `counter` — that group is not yours to author, so a Counter button there would 403 on every body
> you could send.
