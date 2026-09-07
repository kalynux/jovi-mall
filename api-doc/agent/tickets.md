# Agent Tickets

**Verified against source on 2026-09-08** — the 14-route set, the create schema and its length
limits, the `TicketType` / `EntityType` / `TicketImportance` casings and every error code, against
`src/modules/tickets/{routes/agent-ticket.routes.ts, validators/ticket.validator.ts,
types/ticket.types.ts, services/ticket.service.ts}` and `src/core/error-codes.ts`.
**Two corrections: the create example used a ticket type that does not exist, and the 404 row named
`NOT_FOUND` instead of `TICKET_NOT_FOUND`.**

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

> [!IMPORTANT]
> **A ticket and a ticket note are identified by `id`, not `_id`** — on every endpoint on this
> page. `Ticket` is built on `BaseSchemaOptions` (`src/core/base.schema.ts`), whose `toJSON`
> deletes `_id` and exposes the `id` virtual, so the write endpoints (status, priority, assign,
> close, reopen, and the `PATCH` on the ticket itself) return the document with **`id` alone**.
>
> The three enriched reads — create, list and detail — additionally carry a duplicate **`_id`**,
> because `TicketEnrichmentService` builds its payload with `toObject({ virtuals: true })`, which
> applies no transform. **Key on `id`**: it is the only identifier present on all of them. A
> client that keys on `_id` reads `undefined` the first time it patches a ticket.

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

`POST /api/agent/tickets`:

```json
{
  "subject": "Wrong drop-off address on shipment",
  "description": "The address on shipment SHP-1024 is missing the building number.",
  "type": "ADDRESS_CHANGE",
  "importance": "high",
  "entityType": "SHIPMENT",
  "entityId": "664shp...",
  "trackingNumber": "FDO-260705-090000-K7Q2M"
}
```

⚠ **`type` and `entityType` are SCREAMING_SNAKE; `importance` is lowercase.** They are different
casings in the same body and that is not a typo — `TicketType`/`EntityType` are uppercase enums,
`TicketImportance` is `low` | `medium` | `high` | `critical`. **Compare exactly and do not
lower-case before matching.** (This example said `"delivery_issue"` until 2026-09-08; no such value
has ever existed, and the request `400`s with *"Invalid ticket type"*.) The delivery-shaped types
are `SHIPPING_ISSUE`, `DELIVERY_DELAY`, `DELIVERY_CONFIRMATION` and `ADDRESS_CHANGE`; the full list
is [ticket_types.txt](../ticket_types.txt).

Other limits worth knowing before building the form: `subject` ≤ **200** chars, `description` ≤
**700**, `attachments` ≤ **5** file ids, `trackingNumber` ≤ 120. `entityId` is required for every
`entityType` except `OTHER`, where the server defaults it to the requester's own id.

```json
{ "success": true, "data": { "id": "664tkt...", "subject": "Wrong drop-off address on shipment", "status": "open", "...": "..." } }
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query fails the schema |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-agent caller |
| `TICKET_NOT_FOUND` | 404 | Ticket id not found, or not visible to this agent. **Not** `NOT_FOUND`, which this row named until 2026-09-08 — that code is reserved for unmatched routes and never comes out of the ticket module |
| `TICKET_PRIORITY_LOCKED` | 403 | An administrator has set the priority; it never unlocks |
| `TICKET_CLOSED` | 409 | The ticket is closed and no longer editable |
| `TICKET_WAITING_TARGET_NOT_PARTICIPANT` | 400 | `waiting_on_<role>` for a role nobody on the ticket holds. `waiting_on_admin` is always allowed |
| `TICKET_REQUIRED_INFO_MISSING` | 400 | The vendor's support policy needs more. Read `details.missing[]` — `tracking_number` and `product_photo_video` need opposite things from the agent |

## Related
- [vendor/tickets.md](../vendor/tickets.md) — full payload & enum reference
- [agency/tickets.md](../agency/tickets.md) — authoritative enums
- [./shipments.md](./shipments.md) · [./cod-cash.md](./cod-cash.md)
