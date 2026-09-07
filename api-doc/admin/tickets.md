# Admin Tickets

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/tickets` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/tickets`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/support/tickets` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/api-doc/api/` in the wi-admin repository for the dashboard contract.

---

## Base Path

All endpoints in this document share this base path:

```
/api/internal/admin/tickets
```

## Authentication

**Authorization**: Admin access required.

All requests must include a valid Bearer token with admin role:

```
Authorization: Bearer <access_token>
```

## Admin Privileges

Admins have special privileges in the ticketing system:

- ~~**Exclusive Locking**: First admin to act on a ticket becomes the "active admin" and locks the ticket exclusively~~ — ⚠ **REMOVED in Phase 17.** See [Exclusive Admin Locking](#exclusive-admin-locking--deleted-and-this-section-described-it-as-live-until-2026-09-06) below. Who holds a ticket is now `admin_assignment`; who may act is wi-admin's tier decision, not a lock on the row.
- **Priority Locking**: When admin updates priority, it becomes locked permanently
- **Reopen Tickets**: Only admins can reopen closed tickets
- **Remove Followers**: Only admins can remove followers from tickets
- **Delete Attachments**: Only admins can delete attachments
- **Full Visibility**: Admins see all notes and attachments (including private ones)

## Reference Lookups

For populating the ticket-creation form, the same cheap, role-scoped lookups documented in
[vendor/tickets.md](../vendor/tickets.md) are mounted under the admin namespace (admin scope is
unscoped — all orders / all products):

- `GET /api/internal/admin/tickets/reference/orders`
- `GET /api/internal/admin/tickets/reference/products`

When `trackingNumber` is supplied on creation it is persisted and returned as `tracking_number`
on ticket responses (`null` when omitted).

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

### POST /api/internal/admin/tickets

**Description**: Create a new support ticket as an admin.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**: None

**Query Parameters**: None

**Request Body**:
```json
{
  "subject": "string (required, min 1, max 200 chars) - Ticket subject/title",
  "description": "string (required, min 1, max 700 chars) - Detailed description",
  "type": "string (required) - Ticket type. One of the 39 UPPERCASE TicketType values — see ../ticket_types.txt",
  "importance": "string (required) - Importance level. Enum: low, medium, high, critical",
  "entityType": "string (required) - Related entity type. UPPERCASE. Enum: ORDER, PRODUCT, BOOKING, SHIPMENT, DELIVERY, USER, VENDOR, CUSTOMER, AGENT, AGENCY, OTHER",
  "entityId": "string (optional for `OTHER`, required otherwise) - ID of the related entity. For `OTHER` it defaults to the caller's own role-entity id.",
  "trackingNumber": "string (optional, max 120)",
  "attachments": "string[] (optional, max 5) - File ids previously uploaded via POST /api/files/upload",
  "admin": "object (optional) - The administrator's profile snapshot. Sent ONLY on this internal mount; see below."
}
```

> [!WARNING]
> **This block was wrong on six counts until 2026-09-06 and every one of them was a 400.** It
> claimed `subject` min 3 (really **1**), `description` min 10 / max 5000 (really **1 / 700**),
> a five-value lowercase `type` enum — `technical, billing, feature_request, bug_report, other`
> — none of which exists (`CreateTicketSchema.type` is `z.enum(TICKET_TYPE_VALUES)`, the **39
> UPPERCASE** values), `importance: urgent` (that is a **priority** value; importance ends in
> **`critical`**), a five-value lowercase `entityType` including a non-existent `account`, and
> `entityId` as unconditionally required. It also omitted `trackingNumber`, `attachments` and
> `admin` entirely.
>
> **[vendor/tickets.md](../vendor/tickets.md) is the shared payload reference and was correct
> throughout** — one shared `CreateTicketSchema` serves every role's mount, so where the two
> pages disagree about the *body*, that one is right. Only `admin` is genuinely admin-only.
>
> ⚠ **The same applies to the RESPONSE, and this page still under-documents it.** Every read here
> goes through `TicketEnrichmentService`, which adds **`created_by`**, **`assigned_to`** and
> **`entity`** — resolved summary objects beside the raw `*_id` fields — plus `followers` on the
> detail read. The examples below omit all four; `vendor/tickets.md` § "Populated / Enriched
> References" documents them and applies verbatim, because it is the same enrichment.

> [!IMPORTANT]
> **The request is camelCase and the response is snake_case, and that is real.** You send
> `entityType` / `entityId`; the ticket comes back with **`entity_type`** / **`entity_id`**,
> because the Zod schema names the input and `TicketSchema` names the stored document
> (`ticket.model.ts:68-69`). `TicketController.createTicket` maps between them. The same holds
> for `trackingNumber` → `tracking_number`.

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "subject": "System performance issue",
    "description": "Database queries are slow...",
    "type": "TECHNICAL_ISSUE",
    "importance": "critical",
    "priority": "urgent",
    "status": "open",
    "entity_type": "OTHER",
    "entity_id": "string",
    "created_by_user_id": "string",
    "created_by_role": "admin",
    "assigned_to_role": "admin",
    "admin_assignment": { "admin": { "id": "string", "name": "string" }, "assigned_by": { "id": "string", "name": "string" }, "assigned_at": "2026-02-09T23:54:00.000Z" },
    "priority_locked": false,
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  },
  "message": "Ticket created successfully"
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body

---

### GET /api/internal/admin/tickets

**Description**: List all tickets in the system with filters, search, sorting, and pagination. Admins can see all tickets.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `status` (string, optional) - Filter by status. Enum: `open`, `in_progress`, `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_customer`, `waiting_on_agency`, `waiting_on_agent`, `resolved`, `closed`
- `priority` (string, optional) - Filter by priority
- `type` (string, optional) - Filter by type
- `entityType` (string, optional) - Filter by entity type
- `createdByRole` (string, optional) - Filter by creator role
- `assignedToMe` (boolean, optional) - Filter tickets assigned to current admin
- `q` (string, optional, max 100 chars) - Search query
- `page` (integer, optional, default: 1) - Page number
- `limit` (integer, optional, default: 20, max: 100) - Items per page
- `sortBy` (string, optional, default: `createdAt`) - Sort field
- `sortOrder` (string, optional, default: `desc`) - Sort order

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "subject": "Payment integration issue",
      "status": "in_progress",
      "priority": "high",
      "type": "PAYMENT_ISSUE",
      "created_by_role": "vendor",
      "admin_assignment": { "admin": { "id": "string", "name": "string" }, "assigned_by": { "id": "string", "name": "string" }, "assigned_at": "2026-02-09T23:54:00.000Z" },
      "priority_locked": true,
      "createdAt": "2026-02-11T19:00:00.000Z",
      "updatedAt": "2026-02-11T19:00:00.000Z"
    }
  ],
  "meta": {
    "total": 150,
    "page": 1,
    "limit": 20,
    "totalPages": 8
  }
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid query parameters

---

### GET /api/internal/admin/tickets/:id

**Description**: Get detailed information for any ticket in the system.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "subject": "Payment integration issue",
    "description": "Customers are unable to complete checkout...",
    "type": "PAYMENT_ISSUE",
    "importance": "critical",
    "priority": "high",
    "status": "in_progress",
    "entity_type": "ORDER",
    "entity_id": "string",
    "created_by_user_id": "string",
    "created_by_role": "vendor",
    "assigned_to_role": "admin",
    "admin_assignment": { "admin": { "id": "string", "name": "string" }, "assigned_by": { "id": "string", "name": "string" }, "assigned_at": "2026-02-09T23:54:00.000Z" },
    "priority_locked": true,
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

### PATCH /api/internal/admin/tickets/:id

**Description**: Update ticket subject and/or description. Requires exclusive admin lock.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "subject": "string (optional, min 3, max 200 chars) - New subject",
  "description": "string (optional, min 10, max 5000 chars) - New description"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "subject": "Updated subject",
    "description": "Updated description...",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Only ticket **followers** can update a ticket (`ticket.service.ts:524`). ⚠ **Not `FORBIDDEN`, and not a per-admin lock** — see the note at the end of this section.
- `400` – `VALIDATION_ERROR` – Invalid request body

---

### PATCH /api/internal/admin/tickets/:id/status

**Description**: Update ticket status. First admin action locks the ticket exclusively to that admin.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "status": "string (required) - New status. Enum: open, in_progress, waiting_on_admin, waiting_on_vendor, waiting_on_customer, waiting_on_agency, waiting_on_agent, resolved, closed"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "in_progress",
    "admin_assignment": { "admin": { "id": "string", "name": "string" }, "assigned_by": { "id": "string", "name": "string" }, "assigned_at": "2026-02-09T23:54:00.000Z" },
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Status updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Only ticket **followers** can update status (`ticket.service.ts:170`). ⚠ **Not `FORBIDDEN`, and not a per-admin lock.**
- `400` – `VALIDATION_ERROR` – Invalid status value
- `400` – `TICKET_WAITING_TARGET_NOT_PARTICIPANT` – A `waiting_on_<role>` status was requested but no participant with that role is on the ticket (does not apply to `waiting_on_admin`)

---

### PATCH /api/internal/admin/tickets/:id/assign

**Description**: Assign the ticket to an **administrator**, or claim it.

> 🔴 **This section's request body was WRONG until 2026-09-06** (DOC-PROGRAM P-4). It documented
> `{ targetRole, targetUserId }`, which the endpoint does not accept. `AssignToAdministratorSchema`
> is **`.strict()`**, so that body is a **`400` on the entire request** — every field unknown.
> wi-admin's gateway (`support/gateways/ticket.gateway.ts:250`) has always sent the correct shape,
> so nothing was broken in practice; but this page is the only contract a reader has, and it
> described a call that cannot work. Same failure mode as BR-014.

**Authorization**: wi-admin service token (`requireAdminCaller`).

**Request Headers**:
- `Authorization: Bearer <INTERNAL_ADMIN_SERVICE_TOKEN>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body** — `.strict()`, so any unknown key is a `400`:
```json
{
  "admin": {
    "id": "wi-admin administrator id",
    "source": "admin",
    "name": "Awa N.",
    "tier": 2,
    "job_title": "Support Lead",
    "department": "Customer Care",
    "avatar_url": "https://…"
  },
  "assignedBy": "…same shape as admin above…"
}
```

| Field | Required | Rule |
|---|---|---|
| `admin` | ✅ | The **assignee**'s snapshot. `id` non-empty · `source` literal `"admin"` (defaulted) · `name` 1–200 · `tier` exactly `1`, `2` or `3` · `job_title`/`department` ≤120 nullable · `avatar_url` ≤2048 nullable |
| `assignedBy` | optional | The **assigner**'s snapshot. **Its absence IS a claim** |

**Why a snapshot and not a user id:** an administrator holds **no `users` row in jovi-mall**, so
there is nothing here to join against. The profile travels with the write so a ticket follower can
be shown who holds their ticket.

⚠ **The server decides claim-vs-assign by comparing ids, not by trusting `assignedBy`.** If the
calling actor's id equals `admin.id`, `assigned_by` is stored as `null` however the body was
filled — so the two cannot disagree.

**Success Response**:

Status: `200 OK` — the updated ticket. **There is no `message` field** on this response.

```json
{ "success": true, "data": { "id": "string", "admin_assignment": { "admin": "…", "assigned_by": null }, "updatedAt": "2026-02-11T19:30:00.000Z" } }
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- ⚠ **This endpoint raises no `403` at all.** Its only refusals are `404 TICKET_NOT_FOUND` and `400 TICKET_ASSIGN_FAILED` (`ticket.service.ts:228-248`). The `403 FORBIDDEN` documented here until 2026-09-06 was unreachable and its code is in no registry.
- `400` – `VALIDATION_ERROR` – Body failed `.strict()` parse (unknown key, bad `tier`, missing `admin`)

---

### PATCH /api/internal/admin/tickets/:id/admin-snapshot

> **Added to this document 2026-09-06** (DOC-PROGRAM). The route existed and appeared in **no**
> API document; found by the route-coverage sweep.

**Description**: **Re-stamp the assignee's profile without changing the assignee.** wi-admin calls
this on every mutation, so the snapshot a customer reads never goes stale behind a rename.

⚠ **Deliberately a different route and a different schema from `/assign`, even though the payload
is a subset — do not merge them.** Sending `{ admin }` to `/assign` means *"this administrator now
holds the ticket, claimed"*: it would **reassign on every edit and clear `assigned_by`**. A refresh
must be structurally unable to express that.

**Authorization**: wi-admin service token (`requireAdminCaller`).

**Request Body** — `.strict()`:
```json
{ "admin": { "id": "…", "source": "admin", "name": "Awa N.", "tier": 2, "job_title": null, "department": null, "avatar_url": null } }
```

Same `AdminSnapshot` shape and rules as `/assign` above. `assignedBy` is **not accepted here** —
sending it is a `400`.

**Success Response**: `204 No Content`. **No body at all**, so do not attempt to parse one.

**Notes**
- The refresh is **guarded on the assignee id** in `TicketService.refreshAdminSnapshot`, so a
  refresh racing a reassignment cannot overwrite the new holder.
- The stored snapshot is *"the best current answer, not a historical record"* (ADR D-10) — which is
  why it is refreshed rather than frozen at assignment.

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Body failed `.strict()` parse

---

### PATCH /api/internal/admin/tickets/:id/priority

**Description**: Update ticket priority. When admin updates priority, it becomes **locked permanently**. Active admin can re-update locked priority.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "priority": "string (required) - New priority. Enum: low, medium, high, critical"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "priority": "urgent",
    "priority_locked": true,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Priority updated and locked"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `TICKET_PRIORITY_LOCKED` – Priority was locked by an administrator. ⚠ **This locks out NON-ADMINS, not other admins** (`ticket.service.ts:399-403`) — an admin may always change a locked priority. Not `FORBIDDEN`.
- `400` – `VALIDATION_ERROR` – Invalid priority value

---

### POST /api/internal/admin/tickets/:id/close

**Description**: Close a ticket. ⚠ **It does NOT "auto-unlock" anything** — the `assigned_admin_id` lock this line described was removed in Phase 17 (see [Exclusive Admin Locking](#exclusive-admin-locking--deleted-and-this-section-described-it-as-live-until-2026-09-06)). `admin_assignment` is left as it is; closing changes the status, not who holds the ticket.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "closed",
    "admin_assignment": null,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket closed successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Only the ticket creator or an admin can close a ticket (`ticket.service.ts:459`). ⚠ **Not `FORBIDDEN`, and not a per-admin lock** — see the note at the end of this section.

---

### POST /api/internal/admin/tickets/:id/reopen

**Description**: Reopen a closed ticket. **Admin only** (`TICKET_ACCESS_DENIED` at 403 otherwise, `ticket.service.ts:481`). ⚠ **The reopening admin does NOT become an "active admin"** — that mechanism was removed in Phase 17 and `admin_assignment` is unchanged by a reopen.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "open",
    "admin_assignment": { "admin": { "id": "string", "name": "string" }, "assigned_by": { "id": "string", "name": "string" }, "assigned_at": "2026-02-09T23:54:00.000Z" },
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket reopened successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Only closed tickets can be reopened

---

### POST /api/internal/admin/tickets/:id/followers

**Description**: Add a follower to a ticket. Respects 5 non-admin user limit.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "userId": "string (required) - User ID to add as follower",
  "role": "string (required) - User's role. Enum: admin, agent, vendor, customer, agency"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Follower added successfully"
}
```

> [!IMPORTANT]
> **There is no `data` on this response.** `TicketController.addFollower` awaits
> `followerService.addFollower(…)`, which returns `void`, and sends `{ success, message }` only.
> Re-read the follower list with `GET /api/internal/admin/tickets/:id` (the detail read is the
> only one that includes `followers`).

**Error Responses**:
- `422` – `TICKET_FOLLOWER_LIMIT_EXCEEDED` – A sixth **distinct non-admin** user was added. Admins are exempt and do not count toward the five.

> [!NOTE]
> **Adding a user who already follows the ticket is idempotent and answers `200`** —
> `TicketFollowerService.addFollower` returns early on `isFollower`. There is no conflict error.
>
> **A non-existent ticket id is not rejected either.** Neither the route nor the service checks
> that the ticket exists before inserting the follower row, so this endpoint answers `200` for an
> id that matches nothing. Do not depend on it as an existence check.

---

### DELETE /api/internal/admin/tickets/:id/followers/:userId

**Description**: Remove a follower from a ticket. **Admin only**.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Ticket ID
- `userId` (string, required) - User ID to remove

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Follower removed successfully"
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found, or that user does not follow it
- `403` – `TICKET_ACCESS_DENIED` – The caller is not an admin, or the target is the ticket creator, the current assignee, or another admin — all four raise this one code

---

### POST /api/internal/admin/tickets/:ticketId/notes

**Description**: Create a note on a ticket. Admins can create PUBLIC or PRIVATE notes.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `ticketId` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "message": "string (required, min 1, max 2000 chars) - Note content",
  "visibility": "string (optional, default: PUBLIC) - Enum: PUBLIC, PRIVATE",
  "visibleToUserIds": "array of strings (optional) - User IDs who can see private note"
}
```

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "ticket_id": "string",
    "message": "Escalating to development team",
    "visibility": "PRIVATE",
    "visible_to_user_ids": ["dev1", "dev2"],
    "author_user_id": "string",
    "author_role": "admin",
    "createdAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Note created successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Invalid message or visibility parameters

---

### GET /api/internal/admin/tickets/:ticketId/notes

**Description**: Get all notes for a ticket. **Admins see all notes** (PUBLIC and PRIVATE).

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `ticketId` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "ticket_id": "string",
      "message": "Working on this issue",
      "visibility": "PUBLIC",
      "author_user_id": "string",
      "author_role": "vendor",
      "createdAt": "2026-02-11T19:30:00.000Z"
    },
    {
      "id": "string",
      "ticket_id": "string",
      "message": "Internal admin note",
      "visibility": "PRIVATE",
      "visible_to_user_ids": ["admin1", "admin2"],
      "author_user_id": "string",
      "author_role": "admin",
      "createdAt": "2026-02-11T19:31:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

### POST /api/internal/admin/tickets/:ticketId/attachments

**Description**: Attach an already-uploaded file to a ticket. The file is **not**
uploaded here — first upload it via `POST /api/files/upload` (images, documents,
archives, audio) **or, for videos, `POST /api/files/upload/video`** (mp4/mov/webm,
70 MB max — see [file-management.md](../vendor/file-management.md#post-apifilesuploadvideo)),
then send the returned `fileId` to this route (same pattern as product images).
Attachments can be PUBLIC or PRIVATE. Max 5 attachments per ticket.

**Authorization**: Admin access required. Admins may attach any file.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `ticketId` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body** (application/json):
```json
{
  "fileId": "string (required) - ID returned by POST /api/files/upload",
  "visibility": "string (optional, default: PUBLIC) - Enum: PUBLIC, PRIVATE",
  "visibleToUserIds": ["string (optional) - user IDs for private attachment visibility"]
}
```

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "fileName": "debug-log.txt",
    "fileSize": 12345,
    "mimeType": "text/plain",
    "url": "http://localhost:8022/api/files/images/2026/02/a1b2c3…_checkout-error.png",
    "uploadedBy": "string",
    "uploadedByRole": "admin",
    "createdAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `404` – `TICKET_ATTACHMENT_MISSING` – `fileId` does not reference an existing file
- `422` – `TICKET_ATTACHMENT_LIMIT_EXCEEDED` – Maximum 5 attachments per ticket
- `400` – `VALIDATION_ERROR` – Missing/invalid `fileId` or visibility parameters

---

### GET /api/internal/admin/tickets/:ticketId/attachments

**Description**: List all attachments for a ticket. **Admins see all attachments** (PUBLIC and PRIVATE).

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `ticketId` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "fileName": "screenshot.png",
      "fileSize": 245678,
      "mimeType": "image/png",
      "url": "http://localhost:8022/api/files/images/2026/02/a1b2c3…_checkout-error.png",
      "uploadedBy": "string",
      "uploadedByRole": "vendor",
      "createdAt": "2026-02-11T19:30:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

### DELETE /api/internal/admin/tickets/attachments/:id

**Description**: Delete an attachment. **Admin only**.

**Authorization**: Admin access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Attachment ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Attachment deleted successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Attachment not found
- `403` – `TICKET_ACCESS_DENIED` – Only admins can delete attachments (`ticket-attachment.service.ts:188`). ⚠ **Not `FORBIDDEN`** — that string is in no registry.

---

## Notes & Constraints

### ~~Exclusive Admin Locking~~ — **DELETED, and this section described it as live until 2026-09-06**

> [!CAUTION]
> **The mechanism below no longer exists.** The `assigned_admin_id` column, the
> `setActiveAdminIfNotSet` / `validateActiveAdminPermission` pair that enforced it, and the
> entire `/api/admin/tickets` mount that depended on it were **removed in Phase 17**. The
> record is the block comment on `ticket.model.ts:96-107`, which states it plainly: *"The
> column, the lock and the whole `/api/admin/tickets` mount that depended on it are gone."*
>
> **Why it was removed, because the reason matters for what replaced it:** it was never an
> assignment — it was an exclusivity lock stamped on an administrator's **first action on any
> ticket**, after which every *other* administrator got a `403`, **Developers included**. A
> Support administrator merely opening a ticket locked a Developer out of it — the exact
> opposite of the tier model wi-admin enforces, where tier 1 sees everything. That mount could
> not have enforced the tier rules in any case: a legacy admin is a platform `users` row and
> carries no tier.
>
> **What is true now:** who holds a ticket is `admin_assignment`
> (`{ admin, assigned_by, assigned_at }`), it is set by an explicit assignment rather than by
> touching the ticket, and **who may act is wi-admin's decision** — `resolveScope('tickets')`
> plus the tier matrix — **not a lock on the row**. The only 403s these endpoints raise are
> `TICKET_ACCESS_DENIED` (followership) and `TICKET_PRIORITY_LOCKED` (which locks out
> **non-admins**, never another admin).

~~**Critical Concept**: When an admin performs the **first action** on a ticket, they become the **active admin** and the ticket is locked exclusively to them.~~

~~**Locking Behavior**: first admin action sets `assigned_admin_id`; other admins can view but not act; only the active admin can update status, priority, assign or close; a non-active admin gets `403 FORBIDDEN`.~~

~~**Auto-Unlock Triggers**: ticket closed or resolved → `assigned_admin_id` cleared.~~

~~**Reopening**: any admin can reopen a closed ticket and becomes the new active admin.~~

### Priority Locking

**Permanent Locking**:
- When admin updates priority → `priority_locked = true` **permanently**
- Locked priorities **cannot** be changed by non-admin users
- **Exception**: Active admin can re-update a locked priority

### Follower Management

**Admin Privileges**:
- Admins can add any user as a follower
- Admins can remove followers (except ticket creator)
- Admins don't count toward 5-user limit
- Maximum 5 non-admin users can follow a ticket (lifetime)

### Visibility & Privacy

**Full Visibility**:
- Admins see **all notes** (PUBLIC and PRIVATE)
- Admins see **all attachments** (PUBLIC and PRIVATE)
- Admin followers are **auto-included** in all private attachments

**Private Items**:
- PRIVATE notes: Visible to admins + author + explicit list
- PRIVATE attachments: Visible to admins + uploader + explicit list

### Immutable Fields

The following cannot be modified:
- `priority_locked` (once set to true)
- `created_by_user_id`
- `created_by_role`
- `importance` (initial value, different from priority)
- `entityType` and `entityId`

### State Transitions

Valid status flow:
```
open → in_progress → waiting_on_<role> → resolved → closed
                     (admin | vendor | customer | agency | agent)

closed → open (via reopen endpoint, admin only)
```

**Waiting status rule**: a `waiting_on_<role>` status can only be set when a
participant (follower) with that role is on the ticket. The creator and assignee
count as participants. `waiting_on_admin` is always allowed (platform admin
support is implicit). Violations return `400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`.

### Timestamps

All timestamp fields are in ISO 8601 format:
```
2026-02-11T19:00:00.000Z
```
