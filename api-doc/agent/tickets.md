# Agent Tickets

Support ticketing for delivery **agents**. Same ticketing engine as the other roles — the same
`TicketController` / `TicketNoteController` / `TicketAttachmentController` are mounted per role and
scoped to the caller.

- **Base path**: `/api/agent/tickets`
- **Auth**: Required · **Permissions**: `agent` only (`requireRole(['agent'])`)
- **Response envelope**: standard `{ success, data, meta?, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> **Shared reference.** Request/response payloads, enums (types, importance, status, entity types),
> the follower system, priority locking and visibility rules are documented once in
> [vendor/tickets.md](../vendor/tickets.md). The **authoritative enum values** are listed in
> [agency/tickets.md](../agency/tickets.md), and the full `TicketType` list as a flat file in
> [ticket_types.txt](../ticket_types.txt).
> This page lists the exact **agent** route set and the agent-specific differences.

> **The administrator on a ticket.** `assigned_admin` is **not** an actor summary — it is
> `{ name, job_title, department, avatar_url }`, and it is **`null` until a wi-admin
> administrator takes the ticket**, which is the state almost every ticket is in.
> `avatar_url` is **reserved and always `null`** — draw the initials from `name`. Full shape
> and the reasoning: [vendor/tickets.md](../vendor/tickets.md#populated--enriched-references).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/tickets` | Create a ticket |
| `GET` | `/agent/tickets` | List the agent's tickets (paginated/filterable) |
| `GET` | `/agent/tickets/reference/orders` | Reference lookup: the agent's orders (for the create form) |
| `GET` | `/agent/tickets/reference/products` | Reference lookup: products (for the create form) |
| `GET` | `/agent/tickets/:id` | Ticket details |
| `PATCH` | `/agent/tickets/:id` | Update editable fields |
| `PATCH` | `/agent/tickets/:id/status` | Change status |
| `PATCH` | `/agent/tickets/:id/assign` | (Re)assign the ticket |
| `PATCH` | `/agent/tickets/:id/priority` | Change priority |
| `POST` | `/agent/tickets/:id/close` | Close the ticket |
| `POST` | `/agent/tickets/:ticketId/notes` | Add a note |
| `GET` | `/agent/tickets/:ticketId/notes` | List notes |
| `POST` | `/agent/tickets/:ticketId/attachments` | Attach a file (from `POST /api/files/upload`) |
| `GET` | `/agent/tickets/:ticketId/attachments` | List attachments |

### Agent-specific notes
- Agents **can** assign (`PATCH …/assign`) and change priority (`PATCH …/priority`) — unlike customers.
- `reference/*` routes are declared before `/:id` so `reference` is never read as a ticket id.
- Attachments reference files uploaded via `POST /api/files/upload` (see [uploads/README.md](../uploads/README.md)).

### Example — create

```json
POST /api/agent/tickets
{
  "subject": "Wrong drop-off address on shipment",
  "description": "The address on shipment SHP-1024 is missing the building number.",
  "type": "delivery_issue",
  "importance": "high",
  "entityType": "SHIPMENT",
  "entityId": "664shp..."
}
```

```json
{ "success": true, "data": { "_id": "664tkt...", "ticket_number": "TKT-1042", "status": "open", "...": "..." } }
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query fails the schema |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-agent caller |
| `NOT_FOUND` | 404 | Ticket id not found / not visible to this agent |

## Related
- [vendor/tickets.md](../vendor/tickets.md) — full payload & enum reference
- [agency/tickets.md](../agency/tickets.md) — authoritative enums
- [./shipments.md](./shipments.md) · [./cod-cash.md](./cod-cash.md)
