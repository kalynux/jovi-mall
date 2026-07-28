# Agency — Agents (Roster & Invites)

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`POST /api/agency/agents/invites`](#invite) — invite an agent by email
- [`GET /api/agency/agents/invites`](#list-invites) — invite history
- [`DELETE /api/agency/agents/invites/:id`](#revoke) — revoke a pending invite
- [`GET /api/agency/agents`](#roster) — the roster (with cash + trust context)
- [`DELETE /api/agency/agents/:id`](#unlink) — remove an agent from the roster
- [`PATCH /api/agency/agents/:id/cod-limit`](#cod-limit) — cap an agent's COD cash exposure

---

## How the roster works

Agents sign up on the platform independently; your roster is built **consensually**: you invite an
agent's email, they accept in their app, and only then does the agent belong to your agency. An
agent belongs to at most ONE agency at a time.

Only rostered agents can be assigned to your shipments
(`PATCH /api/agency/shipments/:id/assign-agent` — see [shipments.md](./shipments.md)), and for
**cash-on-delivery** shipments an assigned agent is mandatory before pickup: the agent is the
cash-accountable party (see [cod-cash-management.md](./cod-cash-management.md)).

---

<a name="invite"></a>
### POST /api/agency/agents/invites

**Description**: Invite a delivery agent to join this agency's roster, by email. If no agent
account exists yet with that email, the invite becomes visible as soon as one does.

**Request Body**:
```json
{ "email": "agent@example.com" }
```

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "665f1f77bcf86cd799439200",
    "email": "agent@example.com",
    "status": "pending",
    "createdAt": "2026-07-10T09:00:00.000Z"
  },
  "message": "Invite sent. The agent will see it once signed up with this email."
}
```

**Error Responses**:
- `409` – `DELIVERY_INVITE_ALREADY_PENDING` – An open invite for this email already exists.
- `409` – `DELIVERY_AGENT_ALREADY_IN_AGENCY` – That agent already belongs to an agency
  (`details.sameAgency` says whether it's yours).

---

<a name="list-invites"></a>
### GET /api/agency/agents/invites

**Description**: This agency's invites. Query: `status?` (`pending` | `accepted` | `declined` | `revoked`).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439200",
      "agencyId": "507f1f77bcf86cd799439099",
      "email": "agent@example.com",
      "status": "pending",
      "respondedAt": null,
      "createdAt": "2026-07-10T09:00:00.000Z"
    }
  ]
}
```

---

<a name="revoke"></a>
### DELETE /api/agency/agents/invites/:id

**Description**: Revoke a still-pending invite.

**Success Response** (`200 OK`): the invite with `status: "revoked"`.

**Error Responses**:
- `404` – `DELIVERY_INVITE_NOT_FOUND` – Invite doesn't exist, isn't yours, or is no longer pending.

---

<a name="roster"></a>
### GET /api/agency/agents

**Description**: The agency's agent roster, with each agent's live COD context.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439101",
      "name": "Paul N.",
      "email": "agent@example.com",
      "phone": "+2376...",
      "avatar": null,
      "status": "active",
      "vehicleInfo": { "vehicle_type": "bike", "plate_number": "LT-123-AB", "color": "red" },
      "capacityStatus": "available",
      "trustScore": 95,
      "codMaxExposureOverride": null,
      "cashHeld": 130000,
      "joinedAgencyAt": "2026-07-01T10:00:00.000Z"
    }
  ]
}
```

| COD field | Description |
|---|---|
| `cashHeld` | Cash the agent has collected and not yet deposited with you. Minor units. |
| `trustScore` | 0–100; drives the agent's effective exposure limit (see [cod-cash-management.md](./cod-cash-management.md#risk)). |
| `codMaxExposureOverride` | Your per-agent cap, or `null` for the platform default. |

---

<a name="unlink"></a>
### DELETE /api/agency/agents/:id

**Description**: Remove an agent from the roster (clears their `agency_id`).

Blocked while the agent still has:
- shipments in flight (`assigned`/`picked_up`/`in_transit`/`agent_delivered`/`failed`), or
- **undeposited COD cash** — record their deposits first.

**Success Response** (`200 OK`): the removed agent's roster entry.

**Error Responses**:
- `404` – `DELIVERY_AGENT_NOT_IN_AGENCY` – Agent doesn't exist or isn't on this roster.
- `422` – `DELIVERY_AGENT_HAS_ACTIVE_SHIPMENTS` – `details.activeShipments` in flight.
- `422` – `COD_AGENT_HAS_OUTSTANDING_CASH` – `details.outstanding` still held by the agent.

---

<a name="cod-limit"></a>
### PATCH /api/agency/agents/:id/cod-limit

**Description**: Set this contract's slice of the agent's COD pool, bounding their cash exposure
(held cash + expected cash of assigned uncollected COD shipments) for **your** dispatches. Not
nullable: `0` grants nothing, and is the default. The agent's trust tier still scales the effective
limit down (see [cod-cash-management.md](./cod-cash-management.md#risk)).

The threshold is a **sub-allocation** of the agent's own global pool, so a raise can be refused
because of another agency's slice. See
[agent-roster.md](./agent-roster.md#patch-apiagencyagentsmembershipidcod-limit) for the full contract
and error set.

**Request Body**:
```json
{ "threshold": 150000 }
```

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": { "membershipId": "507f1f77bcf86cd799439011", "threshold": 150000, "headroomAfter": 200000 },
  "message": "COD threshold updated."
}
```

**Error Responses**:
- `404` – `CONTRACT_NOT_FOUND` – Contract doesn't exist or isn't on this roster.
- `422` – `CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS` / `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` /
  `CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING`.
