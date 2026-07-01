# Admin Tickets

## Base Path

All endpoints in this document share this base path:

```
/api/admin/tickets
```

## Authentication

**Authorization**: Admin access required.

All requests must include a valid Bearer token with admin role:

```
Authorization: Bearer <access_token>
```

## Admin Privileges

Admins have special privileges in the ticketing system:

- **Exclusive Locking**: First admin to act on a ticket becomes the "active admin" and locks the ticket exclusively
- **Priority Locking**: When admin updates priority, it becomes locked permanently
- **Reopen Tickets**: Only admins can reopen closed tickets
- **Remove Followers**: Only admins can remove followers from tickets
- **Delete Attachments**: Only admins can delete attachments
- **Full Visibility**: Admins see all notes and attachments (including private ones)

## Reference Lookups

For populating the ticket-creation form, the same cheap, role-scoped lookups documented in
[vendor/tickets.md](../vendor/tickets.md) are mounted under the admin namespace (admin scope is
unscoped — all orders / all products):

- `GET /api/admin/tickets/reference/orders`
- `GET /api/admin/tickets/reference/products`

When `trackingNumber` is supplied on creation it is persisted and returned as `tracking_number`
on ticket responses (`null` when omitted).

## Endpoints

### POST /api/admin/tickets

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
  "subject": "string (required, min 3, max 200 chars) - Ticket subject/title",
  "description": "string (required, min 10, max 5000 chars) - Detailed description",
  "type": "string (required) - Ticket type. Enum: technical, billing, feature_request, bug_report, other",
  "importance": "string (required) - Importance level. Enum: low, medium, high, urgent",
  "entityType": "string (required) - Related entity type. Enum: order, product, booking, account, other",
  "entityId": "string (required) - ID of the related entity"
}
```

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "subject": "System performance issue",
    "description": "Database queries are slow...",
    "type": "technical",
    "importance": "urgent",
    "priority": "critical",
    "status": "open",
    "entityType": "other",
    "entityId": "string",
    "created_by_user_id": "string",
    "created_by_role": "admin",
    "assigned_to_role": "admin",
    "assigned_admin_id": "string",
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

### GET /api/admin/tickets

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
      "_id": "string",
      "subject": "Payment integration issue",
      "status": "in_progress",
      "priority": "high",
      "type": "technical",
      "created_by_role": "vendor",
      "assigned_admin_id": "string",
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

### GET /api/admin/tickets/:id

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
    "_id": "string",
    "subject": "Payment integration issue",
    "description": "Customers are unable to complete checkout...",
    "type": "technical",
    "importance": "urgent",
    "priority": "high",
    "status": "in_progress",
    "entityType": "order",
    "entityId": "string",
    "created_by_user_id": "string",
    "created_by_role": "vendor",
    "assigned_to_role": "admin",
    "assigned_admin_id": "string",
    "priority_locked": true,
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

### PATCH /api/admin/tickets/:id

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
    "_id": "string",
    "subject": "Updated subject",
    "description": "Updated description...",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Ticket is locked to another admin
- `400` – `VALIDATION_ERROR` – Invalid request body

---

### PATCH /api/admin/tickets/:id/status

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
    "_id": "string",
    "status": "in_progress",
    "assigned_admin_id": "string",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Status updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Ticket is locked to another admin
- `400` – `VALIDATION_ERROR` – Invalid status value
- `400` – `TICKET_WAITING_TARGET_NOT_PARTICIPANT` – A `waiting_on_<role>` status was requested but no participant with that role is on the ticket (does not apply to `waiting_on_admin`)

---

### PATCH /api/admin/tickets/:id/assign

**Description**: Assign ticket to a role or specific user.

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
  "targetRole": "string (required) - Role to assign to. Enum: admin, agent, vendor, customer, agency",
  "targetUserId": "string (optional) - Specific user ID. Required for non-admin roles"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "assigned_to_role": "admin",
    "assigned_admin_id": "string",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket assigned successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Ticket is locked to another admin
- `400` – `VALIDATION_ERROR` – Invalid assignment parameters

---

### PATCH /api/admin/tickets/:id/priority

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
    "_id": "string",
    "priority": "critical",
    "priority_locked": true,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Priority updated and locked"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Ticket is locked to another admin (only active admin can re-update locked priority)
- `400` – `VALIDATION_ERROR` – Invalid priority value

---

### POST /api/admin/tickets/:id/close

**Description**: Close a ticket. Auto-unlocks the ticket (clears assigned_admin_id).

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
    "_id": "string",
    "status": "closed",
    "assigned_admin_id": null,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket closed successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Ticket is locked to another admin

---

### POST /api/admin/tickets/:id/reopen

**Description**: Reopen a closed ticket. **Admin only**. Admin who reopens becomes the new active admin.

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
    "_id": "string",
    "status": "open",
    "assigned_admin_id": "string",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket reopened successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Only closed tickets can be reopened

---

### POST /api/admin/tickets/:id/followers

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
  "data": {
    "_id": "string",
    "ticket_id": "string",
    "user_id": "string",
    "role": "vendor",
    "is_admin": false,
    "added_at": "2026-02-11T19:30:00.000Z"
  },
  "message": "Follower added successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `409` – `ALREADY_FOLLOWING` – User is already following this ticket
- `400` – `FOLLOWER_LIMIT_EXCEEDED` – Maximum 5 non-admin users reached

---

### DELETE /api/admin/tickets/:id/followers/:userId

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
- `404` – `NOT_FOUND` – Ticket or follower not found
- `403` – `FORBIDDEN` – Cannot remove ticket creator from followers

---

### POST /api/admin/tickets/:ticketId/notes

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
    "_id": "string",
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

### GET /api/admin/tickets/:ticketId/notes

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
      "_id": "string",
      "ticket_id": "string",
      "message": "Working on this issue",
      "visibility": "PUBLIC",
      "author_user_id": "string",
      "author_role": "vendor",
      "createdAt": "2026-02-11T19:30:00.000Z"
    },
    {
      "_id": "string",
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

### POST /api/admin/tickets/:ticketId/attachments

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
    "url": "http://localhost:3000/storage/ticket-attachments/...",
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

### GET /api/admin/tickets/:ticketId/attachments

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
      "url": "http://localhost:3000/storage/ticket-attachments/...",
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

### DELETE /api/admin/tickets/attachments/:id

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
- `403` – `FORBIDDEN` – Only admins can delete attachments

---

## Notes & Constraints

### Exclusive Admin Locking

**Critical Concept**: When an admin performs the **first action** on a ticket, they become the **active admin** and the ticket is locked exclusively to them.

**Locking Behavior**:
- First admin action sets `assigned_admin_id`
- Other admins can **view** ticket metadata but **cannot perform actions**
- Only the active admin can update status, priority, assign, close, etc.
- Attempting action as non-active admin returns `403 FORBIDDEN`

**Auto-Unlock Triggers**:
- Ticket is **closed** → `assigned_admin_id` cleared
- Ticket is **resolved** → `assigned_admin_id` cleared

**Reopening**:
- Any admin can reopen a closed ticket
- Admin who reopens becomes the new active admin

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
