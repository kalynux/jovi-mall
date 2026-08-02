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
      "coverageAreas": ["littoral", "centre"],
      "rating": null,
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

> **Your commission is not here.** `fee_split` is negotiated per contract, so there is nothing to
> show until one exists. The `policies` block is the agency's *vendor-facing* terms (pricing model,
> returns, damage) — useful context for how they operate, not terms that bind you.

---

### POST /api/agent/memberships/requests

**Description**: Apply to an agency. Creates a `pending` contract the agency must approve.

**Request Body**:
```json
{ "agencyId": "507f1f77bcf86cd799439099" }
```

**Success Response** (`201 Created`): an `AgentMembershipDto`, `status: "pending"`,
`origin: "join_request"`, `initiatedBy: "agent"`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
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

**Success Response** (`200 OK`): an array of `AgentMembershipDto` each carrying an extra
`agencyName`, plus `meta`.

```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439300",
      "agentId": "507f1f77bcf86cd799439011",
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "status": "active",
      "origin": "join_request",
      "initiatedBy": "agent",
      "isPrimary": true,
      "employment": { "employmentType": "contractor", "employeeRef": null, "startedAt": null, "endsAt": null },
      "remittanceTerms": { "cadence": "daily", "dayOfWeek": null, "dayOfMonth": null, "graceHours": 24 },
      "coverage": { "regions": ["Douala"], "area": null },
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

**Description**: One contract, with the agency's business name resolved.

**Success Response** (`200 OK`): a single `AgentMembershipDto` + `agencyName`, same shape as a row
above.

**Error Responses**: `404 CONTRACT_NOT_FOUND` — unknown, or not yours.

---

### POST /api/agent/memberships/:membershipId/approve

**Description**: Accept a request an **agency** raised. → `active`; they can assign you shipments
(and COD collections) from that moment.

**Success Response** (`200 OK`): the contract, `status: "active"`, message *"You have joined the
agency."*

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONTRACT_NOT_FOUND` | Unknown, or not yours |
| `403` | `CONTRACT_TRANSITION_NOT_PERMITTED` | **You** raised this one — withdraw it, don't approve it. `details: { transition, party, initiator, hint }` |
| `409` | `CONTRACT_INVALID_TRANSITION` | Not `pending` any more. `details: { from, allowedFrom }` |
| `422` | `AGENT_KYC_NOT_VERIFIED` | Platform gates are re-checked **here** |
| `403` | `AGENT_PLATFORM_BANNED` | Likewise |
| `422` | `AGENT_MEMBERSHIP_LIMIT_REACHED` | Too many agencies. `details: { current, max }` |
| `422` | `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | The COD slice does not fit your pool |

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

**Description**: Changes an **agency** has raised that need your consent — most often a termination.

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
for the full `AgentMembershipDto` and `ContractStatusRequestDto`, and the TypeScript block beneath
it. Your views add one field:

```typescript
interface AgentMembershipWithAgencyDto extends AgentMembershipDto {
  /** The agency's business name, resolved from their Magazin. null if unset. */
  agencyName: string | null;
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
GET   /api/agent/memberships?status=pending
GET   /api/agent/memberships/665f...
POST  /api/agent/memberships/665f.../approve
POST  /api/agent/memberships/665f.../reject            { "reason": "Too far" }
POST  /api/agent/memberships/665f.../withdraw
POST  /api/agent/memberships/665f.../terminate         { "reason": "Moving cities" }
POST  /api/agent/memberships/665f.../transitions       { "transition": "pause" }
PUT   /api/agent/memberships/665f.../primary
GET   /api/agent/memberships/status-requests
```

---

## Notifications

Three agent-facing situations, all gated on the `contractUpdated` preference
(see [notifications.md](./notifications.md)):

- `agent_contract.request_received` — an agency wants you to deliver for them. **This is now the
  only signal** that a request is waiting; there is no invite inbox to poll.
- `agent_contract.approved` — an agency approved your application.
- `agent_contract.rejected` — an agency declined your application.

Each carries `contractId` and `agencyName`, and deep-links to `memberships/{{contractId}}`. The same
three event names are consumed by the **agency** stack with different copy; a `recipientRole`
discriminator decides whose they are. See
[the agency's side](../agency/agent-roster.md#notifications).
