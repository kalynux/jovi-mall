# Agent — Agency Memberships

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

## How membership works

Agents sign up independently (see [onboarding.md](./onboarding.md)) and are **not** attached to any
delivery agency at first. An agent may serve **several agencies at once** — each relationship is a
separate *membership* carrying its own status, employment terms and COD limit.

There are two consensual ways into an agency, differing in who consents first:

| Path | Flow | Resulting status |
|---|---|---|
| **Invitation** | Agency invites an email → agent accepts | `approved` immediately |
| **Join request** | Agent applies to an agency → agency approves | `pending` → `approved` |

An invitation already *is* the agency's consent, so accepting needs no second approval. A join
request has no agency consent yet — that is what the approval step supplies.

### Membership lifecycle

```
pending ──approve──> approved <──reinstate── suspended
   │                    │  │                     │
   └──decline──> removed <┴──remove─────────────-┘
```

- **`pending`** — awaiting the agency's decision (join requests only).
- **`approved`** — you can be assigned this agency's shipments.
- **`suspended`** — no *new* assignments from this agency. **Shipments already in flight are
  untouched** and you keep working them. Suspension is per-agency: suspended at agency A has no
  effect at agency B.
- **`removed`** — terminal for that membership. Re-joining later creates a *new* membership; the old
  one stays as history.

### Rules

- At most **one live membership per agency**, and at most `AGENT_MAX_AGENCY_MEMBERSHIPS`
  (default 5) live memberships in total.
- Exactly one approved membership is your **primary** agency. The first agency you join becomes
  primary automatically; you can change it. If your primary membership is removed, another approved
  one is promoted automatically.
- Invites are matched against your **account email**. An invite sent before you signed up appears as
  soon as an agent account with that email exists.
- **Leaving** is agency- or admin-initiated, and is blocked while you have *that agency's* shipments
  in flight or hold undeposited COD cash — see [cod-cash.md](./cod-cash.md).

---

### GET /api/agent/invites

**Description**: Pending agency invites addressed to this agent's email.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439200",
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "email": "agent@example.com",
      "status": "pending",
      "respondedAt": null,
      "createdAt": "2026-07-10T09:00:00.000Z"
    }
  ]
}
```

---

### POST /api/agent/invites/:id/accept

**Description**: Join the inviting agency. Creates an **approved** membership; from then on the
agency can assign shipments (and COD collections) to this agent.

**Path Parameters**: `id` — the invite id.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "invite": {
      "id": "665f1f77bcf86cd799439200",
      "agencyId": "507f1f77bcf86cd799439099",
      "email": "agent@example.com",
      "status": "accepted",
      "respondedAt": "2026-07-15T09:00:00.000Z",
      "createdAt": "2026-07-10T09:00:00.000Z"
    },
    "membership": {
      "id": "665f1f77bcf86cd799439300",
      "agentId": "507f1f77bcf86cd799439011",
      "agencyId": "507f1f77bcf86cd799439099",
      "status": "approved",
      "origin": "invitation",
      "isPrimary": true,
      "employment": {
        "employmentType": "contractor",
        "employeeRef": null,
        "startedAt": null,
        "endsAt": null
      },
      "codMaxExposureOverride": null,
      "approvedAt": "2026-07-15T09:00:00.000Z"
    }
  },
  "message": "You have joined the agency."
}
```

**Errors**:
- `404` – `DELIVERY_INVITE_NOT_FOUND` – no such invite, not addressed to your email, or no longer pending.
- `409` – `AGENT_MEMBERSHIP_ALREADY_EXISTS` – you already have a live membership with this agency. `details: { status, membershipId }`.
- `422` – `AGENT_MEMBERSHIP_LIMIT_REACHED` – too many agencies. `details: { current, max }`.

> The invite is consumed only **after** the membership is created. If creation fails, the invite
> stays pending so you can retry.

---

### POST /api/agent/invites/:id/decline

**Description**: Decline a pending invite.

**Success Response** (`200 OK`): the resolved invite with `status: "declined"`.

**Errors**:
- `404` – `DELIVERY_INVITE_NOT_FOUND`.

---

### GET /api/agent/memberships

**Description**: The agencies you serve.

**Query Parameters**:
- `status?` – `pending` | `approved` | `suspended` | `removed`. Omitted returns all **live**
  memberships (everything except `removed`).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439300",
      "agentId": "507f1f77bcf86cd799439011",
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "status": "approved",
      "origin": "invitation",
      "isPrimary": true,
      "employment": {
        "employmentType": "contractor",
        "employeeRef": "EMP-042",
        "startedAt": "2026-01-05T00:00:00.000Z",
        "endsAt": null
      },
      "codMaxExposureOverride": 500000,
      "invitedAt": "2026-01-01T00:00:00.000Z",
      "requestedAt": null,
      "approvedAt": "2026-01-05T00:00:00.000Z",
      "suspendedAt": null,
      "suspensionReason": null,
      "removedAt": null,
      "removalReason": null,
      "transferredToAgencyId": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-05T00:00:00.000Z"
    }
  ]
}
```

**Notes**:
- `codMaxExposureOverride` is **that agency's** cap on your cash exposure (minor units); each agency
  sets its own independently. `null` = platform default.
- `origin` is how the membership began: `invitation` | `join_request` | `transfer` | `admin` | `migration`.

---

### POST /api/agent/memberships/requests

**Description**: Apply to join an agency. Creates a `pending` membership the agency must approve.

**Request Body**:
```json
{ "agencyId": "507f1f77bcf86cd799439099" }
```

**Success Response** (`201 Created`): the created membership with `status: "pending"`.

**Errors**:
- `404` – `DELIVERY_AGENCY_NOT_FOUND`.
- `409` – `AGENT_MEMBERSHIP_ALREADY_EXISTS` – `details: { status, membershipId }`.
- `422` – `AGENT_MEMBERSHIP_LIMIT_REACHED` – `details: { current, max }`.

---

### PUT /api/agent/memberships/:membershipId/primary

**Description**: Set your default agency. The previous primary is cleared automatically.

**Success Response** (`200 OK`): the membership, `isPrimary: true`.

**Errors**:
- `404` – `AGENT_MEMBERSHIP_NOT_FOUND` – unknown, or not yours.
- `409` – `AGENT_MEMBERSHIP_NOT_APPROVED` – only an approved membership can be primary. `details: { status }`.

---

### GET /api/agent/memberships/history

**Description**: Your membership trail across every agency — append-only, newest first.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439400",
      "membershipId": "665f1f77bcf86cd799439300",
      "agentId": "507f1f77bcf86cd799439011",
      "agencyId": "507f1f77bcf86cd799439099",
      "type": "suspended",
      "fromStatus": "approved",
      "toStatus": "suspended",
      "actorRole": "agency",
      "reason": "Repeated late deposits",
      "metadata": null,
      "occurredAt": "2026-06-01T12:00:00.000Z"
    }
  ]
}
```

**Event types**: `invited`, `invite_accepted`, `invite_declined`, `invite_revoked`, `join_requested`,
`approved`, `request_declined`, `suspended`, `reinstated`, `removed`, `transferred_out`,
`transferred_in`, `primary_changed`, `employment_updated`, `cod_limit_changed`.

> `actorRole` is reported but never the actor's user id — which staffer at an agency clicked
> "suspend" is not exposed across the role boundary.
