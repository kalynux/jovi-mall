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
  "entityId": "string (optional for `other`, required otherwise) - ID of the related entity (e.g., order ID). For `other`, defaults to the requester's own id.",
  "trackingNumber": "string (optional, max 120) - Required only for ORDER tickets when the vendor's support policy lists `tracking_number`",
  "attachments": "string[] (optional, max 5) - File references; required for ORDER/PRODUCT tickets when the vendor's support policy lists `product_photo_video`"
}
```

> **Entity validation.** When `entityType` is `order`/`booking`/`product`, the `entityId`
> must exist or the request returns `404 TICKET_ENTITY_NOT_FOUND`. For `other` (general or
> policy questions) `entityId` is optional and defaults to the requester's own id.
>
> **Support policy `required_info`.** If the entity's vendor has a support policy with
> `required_info`, creation is rejected with `400 TICKET_REQUIRED_INFO_MISSING`
> (`details.missing[]` lists what's absent). These items are order/product-centric and are
> **only** enforced on the relevant ticket contexts — never on booking or `other` tickets
> (e.g. a billing/payout question is never asked for a tracking number):
> - `order_number` → satisfied implicitly by filing under an `order` entity.
> - `tracking_number` → required for `order` tickets only.
> - `product_photo_video` → required for `order` or `product` tickets (≥ 1 attachment).

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
    "type": "PAYMENT_ISSUE",
    "importance": "urgent",
    "priority": "normal",
    "status": "open",
    "entity_type": "ORDER",
    "entity_id": "string",
    "tracking_number": "FS-1234567890",
    "entity": {
      "type": "ORDER",
      "id": "string",
      "label": "Order ORD-2026-001003",
      "reference": "ORD-2026-001003"
    },
    "created_by_user_id": "string",
    "created_by_role": "vendor",
    "created_by": {
      "user_id": "string",
      "role": "vendor",
      "name": "Acme Store",
      "avatar_url": null
    },
    "assigned_to_role": null,
    "assigned_to": null,
    "assigned_admin_id": null,
    "assigned_admin": null,
    "priority_locked": false,
    "followers": [
      {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar_url": null
      }
    ],
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  },
  "message": "Ticket created successfully"
}
```

> **Tracking number.** When provided, `trackingNumber` is stored on the ticket and returned
> as `tracking_number` on all ticket responses. It is `null` when omitted (e.g. an ORDER ticket
> filed before the order is dispatched, when the vendor policy does not require it).

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body (missing required fields, invalid enum values)

---

### GET /api/vendor/tickets/reference/orders

**Description**: Cheap, read-only list of orders the requester can reference when creating a
ticket — used to populate `entityId` (order id) and `trackingNumber`. Role-scoped: each actor
sees only their own orders (customer → own orders, vendor → own orders, agency → orders with an
item assigned to them, agent → orders with a shipment assigned to them).

> This endpoint is mounted under **every** ticket namespace, scoped to the caller's role:
> `/api/customer/tickets/reference/orders`, `/api/vendor/...`, `/api/agency/...`, `/api/agent/...`,
> `/api/admin/...` (admin is unscoped).

**Query Parameters**:
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 50)
- `q` (string, optional) — server-side search over **order number**, **customer name**, and **tracking number** (case-insensitive).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439010",
      "orderNumber": "ORD-2026-001003",
      "orderType": "physical",
      "fulfillmentStatus": "processing",
      "createdAt": "2026-02-09T23:54:00.000Z",
      "customerName": "Jane Doe",
      "customerAvatarUrl": "https://...",
      "shipments": [
        {
          "shipmentId": "507f1f77bcf86cd799439100",
          "agencyId": "507f1f77bcf86cd799439099",
          "agencyName": "FastShip Logistics",
          "agentId": null,
          "trackingNumber": "FS-1234567890",
          "status": "assigned"
        }
      ]
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

> - `customerName` / `customerAvatarUrl` are the picker's primary row label and thumbnail; `null` when the customer profile cannot be resolved.
> - `shipments[].agencyName` labels each tracking number with the agency in charge of that shipment.
> - `shipments[].trackingNumber` is `null` until the agency/agent records one (order not yet dispatched). An order split across agencies lists multiple shipments — each with its own agency + tracking number.

---

### GET /api/vendor/tickets/reference/products

**Description**: Cheap, read-only list of products the requester can reference when creating a
ticket — used to populate `entityId` (product id). Role-scoped: vendor → own catalogue; admin →
all products; customer/agency/agent → products appearing in the orders they can see.

> Mounted under every ticket namespace, scoped to the caller's role (same pattern as
> `reference/orders`).

**Query Parameters**:
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 50)
- `q` (string, optional) — server-side search over **title**, **category**, and **tags** (case-insensitive).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439200",
      "title": "Wireless Headphones",
      "slug": "wireless-headphones",
      "category": "Electronics",
      "tags": ["audio", "bluetooth"],
      "firstFileUrl": "https://.../headphones-1.jpg"
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

> `firstFileUrl` is the URL of the product's first image (row thumbnail), or `null` when the
> product has no files. `category` is `null` and `tags` is `[]` when unset.

---

### GET /api/vendor/tickets

**Description**: List all tickets created by the vendor with filters, search, sorting, and pagination.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `status` (string, optional) - Filter by status. Enum: `open`, `in_progress`, `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_customer`, `waiting_on_agency`, `waiting_on_agent`, `resolved`, `closed`
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
      "subject": "Payment integration fails at checkout for WhatsApp orders",
      "description": "Several customers report that the 'Pay now' button...",
      "status": "in_progress",
      "priority": "high",
      "importance": "urgent",
      "type": "PAYMENT_ISSUE",
      "entity_type": "ORDER",
      "entity_id": "string",
      "tracking_number": "FS-1234567890",
      "entity": {
        "type": "ORDER",
        "id": "string",
        "label": "Order ORD-2026-001003",
        "reference": "ORD-2026-001003"
      },
      "created_by_user_id": "string",
      "created_by_role": "vendor",
      "created_by": {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar_url": null
      },
      "assigned_to_role": "admin",
      "assigned_to": null,
      "assigned_admin_id": "string",
      "assigned_admin": {
        "user_id": "string",
        "role": "admin",
        "name": "Kofi Mensah",
        "avatar_url": null
      },
      "priority_locked": true,
      "createdAt": "2026-02-11T19:00:00.000Z",
      "updatedAt": "2026-02-11T19:00:00.000Z"
    }
  ],
  "pagination": {
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
    "subject": "Payment integration fails at checkout for WhatsApp orders",
    "description": "Several customers report that the 'Pay now' button...",
    "type": "PAYMENT_ISSUE",
    "importance": "urgent",
    "priority": "high",
    "status": "in_progress",
    "entity_type": "ORDER",
    "entity_id": "string",
    "entity": {
      "type": "ORDER",
      "id": "string",
      "label": "Order ORD-2026-001003",
      "reference": "ORD-2026-001003"
    },
    "created_by_user_id": "string",
    "created_by_role": "vendor",
    "created_by": {
      "user_id": "string",
      "role": "vendor",
      "name": "Acme Store",
      "avatar_url": null
    },
    "assigned_to_role": "admin",
    "assigned_to": null,
    "assigned_admin_id": "string",
    "assigned_admin": {
      "user_id": "string",
      "role": "admin",
      "name": "Kofi Mensah",
      "avatar_url": "https://.../kofi.png"
    },
    "priority_locked": true,
    "followers": [
      {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar_url": null
      },
      {
        "user_id": "string",
        "role": "agent",
        "name": "Lena Park",
        "avatar_url": null
      }
    ],
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
- `400` – `TICKET_WAITING_TARGET_NOT_PARTICIPANT` – A `waiting_on_<role>` status was requested but no participant with that role is on the ticket (does not apply to `waiting_on_admin`)

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
    "content": "Working on resolving this issue",
    "visibility": "public",
    "is_system_note": false,
    "author_user_id": "string",
    "author_role": "vendor",
    "author": {
      "user_id": "string",
      "role": "vendor",
      "name": "Acme Store",
      "avatar_url": null
    },
    "visible_to_user_ids": [],
    "created_at": "2026-02-11T19:30:00.000Z"
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
      "content": "Thanks for flagging — I can reproduce on the staging gateway.",
      "visibility": "public",
      "is_system_note": false,
      "author_user_id": "string",
      "author_role": "admin",
      "author": {
        "user_id": "string",
        "role": "admin",
        "name": "Kofi Mensah",
        "avatar_url": "https://.../kofi.png"
      },
      "visible_to_user_ids": [],
      "created_at": "2026-02-11T19:30:00.000Z"
    },
    {
      "_id": "string",
      "ticket_id": "string",
      "content": "Internal note for admins",
      "visibility": "private",
      "is_system_note": false,
      "author_user_id": "string",
      "author_role": "admin",
      "author": {
        "user_id": "string",
        "role": "admin",
        "name": "Kofi Mensah",
        "avatar_url": "https://.../kofi.png"
      },
      "visible_to_user_ids": ["admin1", "admin2"],
      "created_at": "2026-02-11T19:31:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

### POST /api/vendor/tickets/:ticketId/attachments

**Description**: Attach an already-uploaded file to a ticket. The file is **not**
uploaded here — first upload it via `POST /api/files/upload` (images, documents,
archives, audio) **or, for videos, `POST /api/files/upload/video`** (mp4/mov/webm,
70 MB max — see [file-management.md](./file-management.md#post-apifilesuploadvideo)),
then send the returned `fileId` to this route to link it to the ticket. This
mirrors how product images are attached. Attachments can be PUBLIC (visible to
all followers) or PRIVATE (visible to uploader, admins, and specific users).
Max 5 attachments per ticket.

**Authorization**: Vendor access required. The file must be owned by the caller
or be system-owned (admins can attach any file).

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
    "fileName": "checkout-error.png",
    "fileSize": 245678,
    "mimeType": "image/png",
    "url": "http://localhost:3000/storage/ticket-attachments/...",
    "uploadedBy": "string",
    "uploadedByRole": "vendor",
    "uploadedByActor": {
      "user_id": "string",
      "role": "vendor",
      "name": "Acme Store",
      "avatar_url": null
    },
    "createdAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `404` – `TICKET_ATTACHMENT_MISSING` – `fileId` does not reference an existing file
- `403` – `TICKET_ACCESS_DENIED` – The file belongs to another user (only the file owner or an admin can attach it)
- `422` – `TICKET_ATTACHMENT_LIMIT_EXCEEDED` – Maximum 5 attachments per ticket reached
- `400` – `VALIDATION_ERROR` – Missing/invalid `fileId` or visibility parameters

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
      "fileName": "checkout-error.png",
      "fileSize": 245678,
      "mimeType": "image/png",
      "url": "http://localhost:3000/storage/ticket-attachments/...",
      "uploadedBy": "string",
      "uploadedByRole": "vendor",
      "uploadedByActor": {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar_url": null
      },
      "createdAt": "2026-02-11T19:30:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Ticket not found

---

## Notes & Constraints

### Populated / Enriched References

Every endpoint that returns a ticket, note or attachment also resolves the raw
ObjectId references into ready-to-render summary objects. The original `*_id`
fields are **kept** for backward compatibility; the populated objects are added
alongside them, so the frontend never has to issue follow-up lookups to display
a name, avatar or entity label.

**Actor summary** — used for `created_by`, `assigned_to`, `assigned_admin`,
each entry in `followers`, the note `author`, and the attachment
`uploadedByActor`:

```json
{
  "user_id": "string",
  "role": "vendor",
  "name": "Acme Store",
  "avatar_url": "https://.../logo.png"
}
```

- `name` is resolved from the role-specific profile: admin/customer/agent → `name`, vendor → `display_name` (falls back to `business_name`), agency → `agency_name`.
- `avatar_url` is the profile photo / logo where one exists, otherwise `null`.
- If a reference cannot be resolved (deleted profile, etc.), `name` falls back to the capitalised role (e.g. `"Vendor"`) and `avatar_url` is `null`.
- A `null` value (e.g. `assigned_to: null`, `assigned_admin: null`) means the corresponding `*_id` is unset.

**Entity summary** — used for the ticket `entity` field:

```json
{
  "type": "ORDER",
  "id": "string",
  "label": "Order ORD-2026-001003",
  "reference": "ORD-2026-001003"
}
```

- `label` is a display-ready string (e.g. `Order ORD-2026-001003`, the product title, `Booking on 2026-02-11`).
- `reference` is the human reference where one exists (order number, product slug) or the entity id as a fallback.
- `ORDER`, `PRODUCT` and `BOOKING` are fully resolved; other entity types degrade to a generic label built from the type and a short id suffix.
- `entity` is `null` only when the ticket has no linked entity.

### Ticket Status Values

Valid status values and typical flow:

```
open → in_progress → waiting_on_<role> → resolved → closed
                     (admin | vendor | customer | agency | agent)
```

| Status | Description |
|--------|-------------|
| `open` | Ticket created, awaiting action |
| `in_progress` | Actively being worked on |
| `waiting_on_admin` | Waiting for admin action |
| `waiting_on_vendor` | Waiting for vendor response |
| `waiting_on_customer` | Waiting for customer response |
| `waiting_on_agency` | Waiting for delivery agency response |
| `waiting_on_agent` | Waiting for delivery agent response |
| `resolved` | Issue resolved, awaiting confirmation |
| `closed` | Ticket closed, no further action |

**Waiting status rule**: a `waiting_on_<role>` status can only be set when a
participant (follower) with that role is on the ticket — you cannot wait on a
party that is not involved. The ticket creator and assignee count as
participants. `waiting_on_admin` is the exception: it is always allowed because
platform admin support is implicit. Violations return
`400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`.

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
