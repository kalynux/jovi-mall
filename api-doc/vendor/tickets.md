# Vendor Tickets

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/tickets
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### POST /api/vendor/tickets

**Description**: Create a new support ticket as a vendor.

**Authorization**: Vendor access required.

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
  "entityId": "string (required) - ID of the related entity (e.g., order ID)"
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
    "subject": "Payment integration issue",
    "description": "Customers are unable to complete checkout...",
    "type": "technical",
    "importance": "urgent",
    "priority": "medium",
    "status": "open",
    "entityType": "order",
    "entityId": "string",
    "created_by_user_id": "string",
    "created_by_role": "vendor",
    "assigned_to_role": "admin",
    "priority_locked": false,
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  },
  "message": "Ticket created successfully"
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body (missing required fields, invalid enum values)

---

### GET /api/vendor/tickets

**Description**: List all tickets created by the vendor with filters, search, sorting, and pagination.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `status` (string, optional) - Filter by status. Enum: `open`, `in_progress`, `waiting_on_customer`, `waiting_on_admin`, `resolved`, `closed`
- `priority` (string, optional) - Filter by priority. Enum: `low`, `medium`, `high`, `critical`
- `type` (string, optional) - Filter by type. Enum: `technical`, `billing`, `feature_request`, `bug_report`, `other`
- `entityType` (string, optional) - Filter by entity type
- `q` (string, optional, max 100 chars) - Search query (subject, description)
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 100) - Items per page
- `sortBy` (string, optional, default: `createdAt`) - Sort field. Enum: `createdAt`, `updatedAt`, `priority`
- `sortOrder` (string, optional, default: `desc`) - Sort order. Enum: `asc`, `desc`

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
      "entityType": "order",
      "assigned_admin_id": "string",
      "priority_locked": false,
      "createdAt": "2026-02-11T19:00:00.000Z",
      "updatedAt": "2026-02-11T19:00:00.000Z"
    }
  ],
  "meta": {
    "total": 25,
    "page": 1,
    "limit": 20,
    "totalPages": 2
  }
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid query parameters

---

### GET /api/vendor/tickets/:id

**Description**: Get detailed information for a specific ticket.

**Authorization**: Vendor access required. Only tickets created by the vendor are accessible.

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
- `404` – `NOT_FOUND` – Ticket not found or does not belong to vendor

---

### PATCH /api/vendor/tickets/:id

**Description**: Update ticket subject and/or description. Only the ticket creator can update these fields.

**Authorization**: Vendor access required.

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
- `403` – `FORBIDDEN` – Only ticket creator can update ticket details
- `400` – `VALIDATION_ERROR` – Invalid request body

---

### PATCH /api/vendor/tickets/:id/status

**Description**: Update ticket status. Vendors can update status of their own tickets (must be a follower).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "status": "string (required) - New status. Enum: open, in_progress, waiting_on_customer, waiting_on_admin, resolved, closed"
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
    "status": "waiting_on_admin",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Status updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Only ticket followers can update status
- `400` – `VALIDATION_ERROR` – Invalid status value or invalid state transition

---

### PATCH /api/vendor/tickets/:id/assign

**Description**: Assign ticket to a role or specific user. Vendor users cannot assign tickets.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body**:
```json
{
  "targetRole": "string (required) - Role to assign to. Enum: admin, agent, vendor, customer",
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
    "assigned_admin_id": null,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket assigned successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Invalid assignment parameters

---

### PATCH /api/vendor/tickets/:id/priority

**Description**: Update ticket priority. Non-admin users can update priority, but if an admin updates it, the priority becomes locked permanently.

**Authorization**: Vendor access required.

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
    "priority": "high",
    "priority_locked": false,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Priority updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `PRIORITY_LOCKED` – Priority is locked by admin and cannot be modified
- `400` – `VALIDATION_ERROR` – Invalid priority value

---

### POST /api/vendor/tickets/:id/close

**Description**: Close a ticket. Only the ticket creator or an admin can close a ticket.

**Authorization**: Vendor access required.

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
    "updatedAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Ticket closed successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `403` – `FORBIDDEN` – Only ticket creator or admin can close tickets

---

### POST /api/vendor/tickets/:ticketId/notes

**Description**: Create a note on a ticket. Vendors can create PUBLIC notes or PRIVATE notes visible to specific users.

**Authorization**: Vendor access required.

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
    "message": "Working on resolving this issue",
    "visibility": "PUBLIC",
    "author_user_id": "string",
    "author_role": "vendor",
    "createdAt": "2026-02-11T19:30:00.000Z"
  },
  "message": "Note created successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `VALIDATION_ERROR` – Invalid message or visibility parameters

---

### GET /api/vendor/tickets/:ticketId/notes

**Description**: Get all notes for a ticket. Vendors see PUBLIC notes + their own PRIVATE notes + PRIVATE notes they're included in.

**Authorization**: Vendor access required.

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
      "message": "Working on resolving this issue",
      "visibility": "PUBLIC",
      "author_user_id": "string",
      "author_role": "vendor",
      "createdAt": "2026-02-11T19:30:00.000Z"
    },
    {
      "_id": "string",
      "ticket_id": "string",
      "message": "Internal note for admins",
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

### POST /api/vendor/tickets/:ticketId/attachments

**Description**: Upload a file attachment to a ticket. Attachments can be PUBLIC (visible to all followers) or PRIVATE (visible to uploader, admins, and specific users).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**Path Parameters**:
- `ticketId` (string, required) - Ticket ID

**Query Parameters**: None

**Request Body** (multipart/form-data):
- `file` (file, required) - File to upload (max 5 attachments per ticket)
- `visibility` (string, optional, default: PUBLIC) - Enum: `PUBLIC`, `PRIVATE`
- `visibleToUserIds` (JSON array string, optional) - User IDs for private attachment visibility

Example:
```
file: [binary file data]
visibility: PRIVATE
visibleToUserIds: ["user123", "user456"]
```

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "fileName": "screenshot.png",
    "fileSize": 245678,
    "mimeType": "image/png",
    "url": "http://localhost:3000/storage/ticket-attachments/...",
    "uploadedBy": "string",
    "uploadedByRole": "vendor",
    "createdAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found
- `400` – `NO_FILE` – No file provided
- `400` – `ATTACHMENT_LIMIT_EXCEEDED` – Maximum 5 attachments per ticket reached

---

### GET /api/vendor/tickets/:ticketId/attachments

**Description**: List all attachments for a ticket. Vendors see PUBLIC attachments + their own PRIVATE attachments + PRIVATE attachments they're included in.

**Authorization**: Vendor access required.

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

## Notes & Constraints

### Ticket Status Values

Valid status values and typical flow:

```
open → in_progress → waiting_on_admin → resolved → closed
                  ↘ waiting_on_customer ↗
```

| Status | Description |
|--------|-------------|
| `open` | Ticket created, awaiting action |
| `in_progress` | Actively being worked on |
| `waiting_on_customer` | Waiting for customer response |
| `waiting_on_admin` | Waiting for admin action |
| `resolved` | Issue resolved, awaiting confirmation |
| `closed` | Ticket closed, no further action |

### Priority Locking

- When an **admin** updates priority, it becomes **locked permanently**
- Locked priorities cannot be changed by non-admin users
- The active admin (who locked the ticket) can re-update a locked priority

### Exclusive Admin Locking

- When an admin performs the **first action** on a ticket, they become the **active admin**
- While locked, **only the active admin** can perform actions on the ticket
- Other admins can view metadata but cannot perform actions
- Auto-unlocks when ticket is **closed** or **resolved**

### Visibility Controls

**Notes:**
- `PUBLIC` - Visible to all ticket followers
- `PRIVATE` - Visible to author, all admins, and explicit user list

**Attachments:**
- `PUBLIC` - Visible to all ticket followers (default)
- `PRIVATE` - Visible to uploader, all admin followers, and explicit user list
- Admins are auto-included in all private attachments

### Attachment Limits

- Maximum **5 attachments** per ticket
- Attachments are immutable after upload
- Only admins can delete attachments

### Follower System

- Ticket creator is automatically added as a follower
- Maximum **5 non-admin users** can follow a ticket (lifetime limit)
- Admins don't count toward the 5-user limit
- Only admins can remove followers

### Entity References

Tickets must be associated with a related entity:
- `order` - Order-related issues
- `product` - Product-related issues
- `booking` - Booking-related issues
- `account` - Account-related issues
- `other` - General issues

### Timestamps

All timestamp fields are returned in ISO 8601 format:
```
2026-02-11T19:00:00.000Z
```
