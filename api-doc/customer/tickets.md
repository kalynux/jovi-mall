# Customer Tickets

Support ticketing for **customers**. Same ticketing engine as the other roles — the same
`TicketController` / `TicketNoteController` / `TicketAttachmentController`, scoped to the caller.

- **Base path**: `/api/customer/tickets`
- **Auth**: Required · **Permissions**: `customer` only (`requireRole(['customer'])`)
- **Response envelope**: standard `{ success, data, meta?, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> **Shared reference.** Payloads, enums, follower system and visibility rules are documented in
> [vendor/tickets.md](../vendor/tickets.md); the **authoritative enum values** are in
> [agency/tickets.md](../agency/tickets.md). This page lists the exact **customer** route set and the
> customer-specific restrictions.

> **The administrator on a ticket.** `assigned_admin` is **not** an actor summary — it is
> `{ name, job_title, department, avatar_url }`, and it is **`null` until a wi-admin
> administrator takes the ticket**, which is the state almost every ticket is in.
> `avatar_url` is **reserved and always `null`** — draw the initials from `name`. Full shape
> and the reasoning: [vendor/tickets.md](../vendor/tickets.md#populated--enriched-references).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/customer/tickets` | Create a ticket |
| `GET` | `/customer/tickets` | List the customer's tickets |
| `GET` | `/customer/tickets/reference/orders` | Reference lookup: the customer's orders |
| `GET` | `/customer/tickets/reference/products` | Reference lookup: products |
| `GET` | `/customer/tickets/:id` | Ticket details |
| `PATCH` | `/customer/tickets/:id` | Update editable fields |
| `PATCH` | `/customer/tickets/:id/status` | Change status |
| `POST` | `/customer/tickets/:id/close` | Close the ticket |
| `POST` | `/customer/tickets/:ticketId/notes` | Add a **public** note |
| `GET` | `/customer/tickets/:ticketId/notes` | List notes |
| `POST` | `/customer/tickets/:ticketId/attachments` | Attach a file (from `POST /api/files/upload`) |
| `GET` | `/customer/tickets/:ticketId/attachments` | List attachments |

### Customer-specific restrictions (differ from staff roles)
- **No `assign` and no `priority` endpoints** — customers cannot reassign or reprioritise tickets.
- **Notes are public-only** — `POST …/notes` always creates a public note (internal notes are rejected
  server-side). Customers never see internal staff notes.
- A customer sees only **their own** tickets.

### Example — create

```json
POST /api/customer/tickets
{
  "subject": "Order arrived damaged",
  "description": "One of the two items in order #ORD-5521 was cracked.",
  "type": "order_issue",
  "importance": "medium",
  "entityType": "ORDER",
  "entityId": "664ord..."
}
```

```json
{ "success": true, "data": { "_id": "664tkt...", "ticket_number": "TKT-1043", "status": "open", "...": "..." } }
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query fails the schema |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-customer caller |
| `NOT_FOUND` | 404 | Ticket id not found / not the customer's |

## Related
- [vendor/tickets.md](../vendor/tickets.md) — full payload & enum reference
- [./orders.md](./orders.md) · [./profile.md](./profile.md)
