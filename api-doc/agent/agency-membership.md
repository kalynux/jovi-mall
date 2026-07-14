# Agent — Agency Membership (Invites)

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

## How membership works

Agents sign up independently (see [onboarding.md](./onboarding.md)) and are **not** attached to any
delivery agency at first. An agency builds its roster by inviting an agent's **email**; the agent
sees the invite here and accepts or declines. Accepting links the agent to that agency
(`agency_id`), which is what makes the agent assignable to the agency's shipments — including
cash-on-delivery work (see [cod-cash.md](./cod-cash.md)).

Rules:

- An agent belongs to **at most one agency** at a time. Accepting an invite while already linked
  fails with `DELIVERY_AGENT_ALREADY_IN_AGENCY` — the current agency must unlink the agent first.
- Invites are matched against the agent's **account email**. An invite sent before the agent signed
  up appears as soon as an agent account with that email exists.
- The agency can revoke a pending invite at any time; revoked/declined invites disappear from the
  pending list.
- Leaving an agency is agency-initiated (the agency unlinks the agent) and is blocked while the
  agent still has shipments in flight or undeposited COD cash.

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

**Description**: Join the inviting agency. Sets this agent's `agency_id`; from then on the agency
can assign shipments (and COD collections) to this agent.

**Path Parameters**:
- `id` (string, required) — Invite ID.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "invite": { "id": "665f1f77bcf86cd799439200", "status": "accepted" },
    "agencyId": "507f1f77bcf86cd799439099"
  },
  "message": "Invite accepted. You are now part of the agency."
}
```

**Error Responses**:
- `404` – `DELIVERY_INVITE_NOT_FOUND` – Invite doesn't exist, isn't addressed to this agent's email, or is no longer pending.
- `409` – `DELIVERY_AGENT_ALREADY_IN_AGENCY` – Agent is already linked to an agency.

---

### POST /api/agent/invites/:id/decline

**Description**: Decline the invite. The agency may re-invite later.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": { "id": "665f1f77bcf86cd799439200", "status": "declined" },
  "message": "Invite declined."
}
```

**Error Responses**:
- `404` – `DELIVERY_INVITE_NOT_FOUND` – Invite doesn't exist, isn't addressed to this agent, or is no longer pending.
