# Agency Tickets

## Base Path

All endpoints in this document share this base path:

```
/api/agency/tickets
```

## Authentication

**Authorization**: Agency access required.

All requests must include a valid Bearer token with agency role:

```
Authorization: Bearer <access_token>
```

> [!NOTE]
> This is the same ticketing engine documented for other roles (see
> [vendor/tickets.md](../vendor/tickets.md)) — the same controllers/services are mounted under
> `/api/vendor/tickets`, `/api/agency/tickets`, `/api/agent/tickets`, `/api/customer/tickets` and
> `/api/admin/tickets`, scoped to the caller's role. Mechanics (follower system, priority locking,
> visibility rules) are identical across roles; this document lists the **current, authoritative**
> enum values from `src/modules/tickets/types/ticket.types.ts` — some values shown in the vendor
> doc are stale placeholders and should not be used as a reference.

## Endpoints

### POST /api/agency/tickets

**Description**: Create a new support ticket as a delivery agency.

**Authorization**: Agency access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**: None

**Query Parameters**: None

**Request Body**:
```json
{
  "subject": "string (required, 1-200 chars) - Ticket subject/title",
  "description": "string (required, 1-700 chars) - Detailed description",
  "type": "string (required) - Ticket type, see Ticket Types table below",
  "importance": "string (required) - Enum: low, medium, high, critical. Immutable after creation.",
  "entityType": "string (required) - Enum: ORDER, PRODUCT, BOOKING, SHIPMENT, DELIVERY, USER, VENDOR, CUSTOMER, AGENT, AGENCY, OTHER",
  "entityId": "string (optional for OTHER, required otherwise) - ID of the related entity. For OTHER, defaults to the agency's own id.",
  "trackingNumber": "string (optional, max 120 chars) - Carrier tracking number, if relevant",
  "attachments": "string[] (optional, max 5) - File references from prior POST /api/files/upload"
}
```

> **Entity validation is only enforced for `ORDER`, `BOOKING`, and `PRODUCT`.** For these three
> types, `entityId` must reference an existing document or the request fails with
> `404 TICKET_ENTITY_NOT_FOUND`. For every other `entityType` — including `SHIPMENT`, `DELIVERY`,
> and `AGENCY`, which are the most common choices for an agency's own delivery-issue tickets —
> **the id is stored as-is with no existence check**. `OTHER` additionally defaults `entityId` to
> the agency's own id when omitted.
>
> **Filing against `entityType: "ORDER"` inherits the order's vendor's support policy.** When an
> agency files a ticket against an order, the backend resolves that order's `vendor_id` and
> applies **that vendor's** support policy `required_info` rules (`tracking_number` required,
> `product_photo_video` required — see below) exactly as it would for the vendor or a customer.
> This can produce a `400 TICKET_REQUIRED_INFO_MISSING` driven by a policy the agency doesn't
> control. Filing the same complaint against `entityType: "SHIPMENT"` or `"DELIVERY"` instead
> skips this enforcement entirely (no vendor is resolved for those types).
>
> **Support policy `required_info` (only applies to `ORDER`/`PRODUCT` entities):**
> - `tracking_number` → required for `ORDER` tickets only.
> - `product_photo_video` → required for `ORDER` or `PRODUCT` tickets (≥ 1 attachment).
> Rejected with `400 TICKET_REQUIRED_INFO_MISSING` (`details.missing[]` lists what's absent).

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "subject": "Shipment stuck in transit for 3 days",
    "description": "Order ORD-2026-001003 has been in_transit since Monday with no movement...",
    "type": "DELIVERY_DELAY",
    "importance": "high",
    "priority": "normal",
    "status": "open",
    "entity_type": "SHIPMENT",
    "entity_id": "string",
    "tracking_number": "FS-1234567890",
    "entity": {
      "type": "SHIPMENT",
      "id": "string",
      "label": "Shipment a1b2c3",
      "reference": "string"
    },
    "created_by_user_id": "string",
    "created_by_role": "agency",
    "created_by": {
      "user_id": "string",
      "role": "agency",
      "name": "FastTrack Logistics",
      "avatar": { "id": "507f1f77bcf86cd799439030", "key": "products/2026/07/fasttrack-logo.png", "url": "https://cdn.example.com/fasttrack-logo.png", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" }
    },
    "assigned_to_role": null,
    "assigned_to": null,
    "assigned_admin_id": null,
    "assigned_admin": null,
    "priority_locked": false,
    "followers": [
      {
        "user_id": "string",
        "role": "agency",
        "name": "FastTrack Logistics",
        "avatar": { "id": "507f1f77bcf86cd799439030", "key": "products/2026/07/fasttrack-logo.png", "url": "https://cdn.example.com/fasttrack-logo.png", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" }
      }
    ],
    "createdAt": "2026-07-05T19:00:00.000Z",
    "updatedAt": "2026-07-05T19:00:00.000Z"
  }
}
```

> **Actor summary for `agency`.** `name` resolves to `agency_name` and `avatar` to the resolved logo
> **file object** (from the agency's `logo_file_id`) — used for `created_by`, `assigned_to`, and every
> entry in `followers` when the actor is an agency.
>
> **Entity summary for non-`ORDER`/`PRODUCT`/`BOOKING` types** (e.g. `SHIPMENT`, `DELIVERY`,
> `AGENCY`) degrades to a generic placeholder: `label` is `"<Type> <last 6 chars of id>"` and
> `reference` is the raw id — these types are not resolved against a collection.

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body (missing required fields, invalid enum values)
- `400` – `TICKET_ENTITY_NOT_FOUND` – Invalid `entityId` format, or (for `ORDER`/`BOOKING`/`PRODUCT`) the referenced entity does not exist
- `400` – `TICKET_REQUIRED_INFO_MISSING` – Vendor's support policy requires info not supplied (see above)

---

### GET /api/agency/tickets/reference/orders

**Description**: Cheap, read-only list of orders this agency can reference when creating a
ticket — used to populate `entityId` and `trackingNumber`. Scoped to orders that have at least
one item whose delivery is assigned to this agency (`items.delivery.agency_id`).

**Query Parameters**:
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 50)
- `q` (string, optional) — server-side search over order number, customer name, and tracking number (case-insensitive).

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
      "createdAt": "2026-07-05T09:00:00.000Z",
      "customerName": "Jane Doe",
      "customerAvatarUrl": null,
      "shipments": [
        {
          "shipmentId": "507f1f77bcf86cd799439100",
          "agencyId": "507f1f77bcf86cd799439099",
          "agencyName": "FastTrack Logistics",
          "agentId": null,
          "trackingNumber": "FS-1234567890",
          "status": "in_transit"
        }
      ]
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

> `shipments[]` here is further filtered to **this agency's own shipments** on the order — a
> multi-agency order only shows the slice this agency handles, not every agency involved.

---

### GET /api/agency/tickets/reference/products

**Description**: Cheap, read-only list of products this agency can reference when creating a
ticket — used to populate `entityId`. Derived from the products appearing on orders this agency
can see (`OrderModel.distinct('items.product_id', ...)` under the same order scope as above), not
from a product catalogue the agency owns.

**Query Parameters**:
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 50)
- `q` (string, optional) — server-side search over title, category, and tags (case-insensitive).

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

---

### GET /api/agency/tickets

**Description**: List all tickets visible to this agency (created by it, or where it's a
follower/assignee), with filters, search, sorting, and pagination.

**Request Headers**:
- `Authorization: Bearer <token>`

**Query Parameters**:
- `type` (string, optional) — filter by ticket type (see Ticket Types table below)
- `status` (string, optional) — Enum: `open`, `in_progress`, `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_customer`, `waiting_on_agency`, `waiting_on_agent`, `resolved`, `closed`
- `priority` (string, optional) — Enum: `low`, `normal`, `high`, `urgent`
- `entityType` (string, optional) — Enum: `ORDER`, `PRODUCT`, `BOOKING`, `SHIPMENT`, `DELIVERY`, `USER`, `VENDOR`, `CUSTOMER`, `AGENT`, `AGENCY`, `OTHER`
- `entityId` (string, optional)
- `createdByUserId` (string, optional)
- `assignedToRole` (string, optional) — Enum: `admin`, `vendor`, `customer`, `agency`, `agent`
- `assignedToUserId` (string, optional)
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 100)
- `sortBy` (string, optional, default `createdAt`) — Enum: `createdAt`, `updatedAt`, `priority`, `status`
- `sortOrder` (string, optional, default `desc`) — Enum: `asc`, `desc`

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "subject": "Shipment stuck in transit for 3 days",
      "description": "Order ORD-2026-001003 has been in_transit since Monday...",
      "status": "in_progress",
      "priority": "high",
      "importance": "high",
      "type": "DELIVERY_DELAY",
      "entity_type": "SHIPMENT",
      "entity_id": "string",
      "tracking_number": "FS-1234567890",
      "entity": {
        "type": "SHIPMENT",
        "id": "string",
        "label": "Shipment a1b2c3",
        "reference": "string"
      },
      "created_by_user_id": "string",
      "created_by_role": "agency",
      "created_by": {
        "user_id": "string",
        "role": "agency",
        "name": "FastTrack Logistics",
        "avatar": null
      },
      "assigned_to_role": "admin",
      "assigned_to": null,
      "assigned_admin_id": "string",
      "assigned_admin": {
        "user_id": "string",
        "role": "admin",
        "name": "Kofi Mensah",
        "avatar": null
      },
      "priority_locked": true,
      "createdAt": "2026-07-05T19:00:00.000Z",
      "updatedAt": "2026-07-05T19:30:00.000Z"
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid query parameters

---

### GET /api/agency/tickets/:id

**Description**: Get detailed information for a specific ticket. The agency must be a follower
of the ticket (creator, assignee, or explicitly added) to view it.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Success Response**: Status `200 OK` — same shape as a list item above, plus `followers[]` (array
of actor summaries).

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket does not exist
- `403` – `TICKET_ACCESS_DENIED` – Agency is not a follower of this ticket

---

### PATCH /api/agency/tickets/:id

**Description**: Update ticket subject and/or description. Only the ticket creator (or a follower,
for non-admin roles) can update these fields.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Request Body**:
```json
{
  "subject": "string (optional, 1-200 chars)",
  "description": "string (optional, 1-10000 chars)"
}
```
At least one of `subject`/`description` is required.

**Success Response**: `200 OK` — updated ticket document.

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `403` – `TICKET_ACCESS_DENIED` – Only ticket followers can update tickets
- `400` – `VALIDATION_ERROR`

---

### PATCH /api/agency/tickets/:id/status

**Description**: Update ticket status. The agency must be a follower of the ticket.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Request Body**:
```json
{ "status": "waiting_on_admin" }
```
- `status` (string, required) — Enum: `open`, `in_progress`, `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_customer`, `waiting_on_agency`, `waiting_on_agent`, `resolved`, `closed`.

> **Waiting-status rule.** A `waiting_on_<role>` status can only be set when a participant
> (follower) with that role is already on the ticket — you cannot wait on a party that isn't
> involved. `waiting_on_admin` is the exception: always allowed. Violations return
> `400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`.

**Success Response**: `200 OK` — updated ticket document. A system note recording the transition
(`Status changed from "X" to "Y"`) is automatically appended.

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `403` – `TICKET_ACCESS_DENIED` – Only ticket followers can update status
- `400` – `VALIDATION_ERROR` – Invalid status value, or status unchanged
- `400` – `TICKET_WAITING_TARGET_NOT_PARTICIPANT`

---

### PATCH /api/agency/tickets/:id/assign

**Description**: Assign the ticket to a role, optionally a specific user within that role.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Request Body**:
```json
{
  "targetRole": "admin",
  "targetUserId": null
}
```
- `targetRole` (string, required) — Enum: `admin`, `vendor`, `customer`, `agency`, `agent`.
- `targetUserId` (string, optional) — **Required for every role except `admin`** (admin supports
  unassigned "pool" assignment when omitted). If provided, the target user is auto-added as a
  ticket follower (subject to the 5-follower limit).

**Success Response**: `200 OK` — updated ticket document (`assigned_to_role`, `assigned_admin_id`
reflect the new assignment). A system note is appended.

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `400` – `TICKET_ASSIGN_FAILED` – `targetUserId` missing for a non-admin `targetRole`
- `403` – `TICKET_ACCESS_DENIED` – Ticket is exclusively locked to a different admin
- `400` – `VALIDATION_ERROR`

---

### PATCH /api/agency/tickets/:id/priority

**Description**: Update ticket priority.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Request Body**:
```json
{ "priority": "high" }
```
- `priority` (string, required) — Enum: `low`, `normal`, `high`, `urgent`.

> **Priority locking.** If an **admin** sets the priority, it becomes locked permanently — only
> that same active admin can change it again afterward. A non-admin actor (including an agency)
> setting priority does **not** lock it.

**Success Response**: `200 OK` — updated ticket document.

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `409` – `TICKET_CLOSED` – Cannot update priority of a closed ticket
- `403` – `TICKET_PRIORITY_LOCKED` – Priority is locked by an admin
- `400` – `VALIDATION_ERROR`

---

### POST /api/agency/tickets/:id/close

**Description**: Close a ticket. Only the ticket creator or an admin can close it.

**Path Parameters**:
- `id` (string, required) — Ticket ID

**Success Response**: `200 OK` — updated ticket document (`status: "closed"`).

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `403` – `TICKET_ACCESS_DENIED` – Only ticket creator or admin can close tickets

> There is no `POST /:id/reopen` under this namespace — reopening a closed ticket is admin-only
> (`/api/admin/tickets/:id/reopen`).

---

### POST /api/agency/tickets/:ticketId/notes

**Description**: Add a note to a ticket.

**Path Parameters**:
- `ticketId` (string, required) — Ticket ID

**Request Body**:
```json
{
  "content": "string (required, 1-300 chars)",
  "visibility": "string (optional, default: public) - Enum: public, private",
  "visibleToUserIds": "string[] (optional, default: [])"
}
```

> Note the request field is **`content`**, and `visibility` values are **lowercase**
> (`public`/`private`) — distinct from the attachment endpoint below, which uses uppercase
> `PUBLIC`/`PRIVATE`.

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "ticket_id": "string",
    "content": "Picked up 30 minutes ago, en route now.",
    "visibility": "public",
    "is_system_note": false,
    "author_user_id": "string",
    "author_role": "agency",
    "author": {
      "user_id": "string",
      "role": "agency",
      "name": "FastTrack Logistics",
      "avatar": null
    },
    "visible_to_user_ids": [],
    "created_at": "2026-07-05T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `400` – `VALIDATION_ERROR`

---

### GET /api/agency/tickets/:ticketId/notes

**Description**: List notes on a ticket. The agency sees public notes plus any private notes it
authored or is explicitly listed on.

**Path Parameters**:
- `ticketId` (string, required) — Ticket ID

**Success Response**: `200 OK` — array of note objects (same shape as the create response).

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`

---

### POST /api/agency/tickets/:ticketId/attachments

**Description**: Attach an already-uploaded file to a ticket. Upload the file first via
`POST /api/files/upload` (images, documents) or `POST /api/files/upload/video` (mp4/mov/webm, 70MB
max), then send the returned `fileId` here. Max 5 attachments per ticket.

**Path Parameters**:
- `ticketId` (string, required) — Ticket ID

**Request Body**:
```json
{
  "fileId": "string (required) - ID returned by POST /api/files/upload",
  "visibility": "string (optional, default: PUBLIC) - Enum: PUBLIC, PRIVATE",
  "visibleToUserIds": "string[] (optional, min 1 if provided)"
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
    "fileName": "proof-of-attempt.jpg",
    "fileSize": 184320,
    "mimeType": "image/jpeg",
    "url": "http://localhost:3000/storage/ticket-attachments/...",
    "uploadedBy": "string",
    "uploadedByRole": "agency",
    "uploadedByActor": {
      "user_id": "string",
      "role": "agency",
      "name": "FastTrack Logistics",
      "avatar": null
    },
    "createdAt": "2026-07-05T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`
- `404` – `TICKET_ATTACHMENT_MISSING` – `fileId` does not reference an existing file
- `403` – `TICKET_ACCESS_DENIED` – File belongs to another user
- `422` – `TICKET_ATTACHMENT_LIMIT_EXCEEDED` – Max 5 attachments per ticket reached
- `400` – `VALIDATION_ERROR`

---

### GET /api/agency/tickets/:ticketId/attachments

**Description**: List all attachments on a ticket visible to this agency.

**Path Parameters**:
- `ticketId` (string, required) — Ticket ID

**Success Response**: `200 OK` — array of attachment objects (same shape as the create response).

**Error Responses**:
- `404` – `TICKET_NOT_FOUND`

---

## Notes & Constraints

### Ticket Types

`type` accepts any value from the authoritative `TicketType` enum
(`src/modules/tickets/types/ticket.types.ts`):

| Group | Values |
|---|---|
| General Support | `GENERAL_SUPPORT`, `ACCOUNT_ACCESS`, `ACCOUNT_VERIFICATION`, `PROFILE_UPDATE`, `SECURITY_ISSUE` |
| Order Issues | `ORDER_ISSUE`, `ORDER_CANCELLATION`, `ORDER_REFUND`, `ORDER_DISPUTE`, `ORDER_FULFILLMENT` |
| Payment Issues | `PAYMENT_ISSUE`, `PAYMENT_FAILED`, `PAYMENT_CONFIRMATION`, `CHARGEBACK`, `INVOICE_REQUEST` |
| Payout Issues | `PAYOUT_REQUEST`, `PAYOUT_DELAY`, `PAYOUT_DISPUTE`, `COMMISSION_QUESTION` |
| Booking Issues | `BOOKING_ISSUE`, `BOOKING_CANCELLATION`, `BOOKING_RESCHEDULE`, `AVAILABILITY_PROBLEM` |
| Product Issues | `PRODUCT_ISSUE`, `INVENTORY_PROBLEM`, `PRICING_ISSUE`, `VARIANT_ISSUE` |
| Shipping/Delivery | `SHIPPING_ISSUE`, `DELIVERY_DELAY`, `DELIVERY_CONFIRMATION`, `ADDRESS_CHANGE` |
| Technical | `TECHNICAL_ISSUE`, `BUG_REPORT`, `INTEGRATION_ISSUE`, `API_ACCESS` |
| Policy/Legal | `POLICY_QUESTION`, `COMPLIANCE`, `LEGAL_REQUEST` |
| Other | `OTHER` |

For a delivery agency, **Shipping/Delivery**, **Payout Issues**, and **General Support** are the
most relevant groups, but any value is accepted.

### Populated / Enriched References

Every endpoint that returns a ticket, note, or attachment resolves the raw ObjectId references
into ready-to-render summary objects. The original `*_id` fields are kept alongside them.

**Actor summary** (`created_by`, `assigned_to`, `assigned_admin`, each `followers` entry, note
`author`, attachment `uploadedByActor`):
```json
{ "user_id": "string", "role": "agency", "name": "FastTrack Logistics", "avatar": { "id": "…", "key": "…", "url": "https://.../logo.png", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" } }
```
- `name`: admin/customer/agent → `name`; vendor → `display_name` (falls back to `business_name`);
  **agency → `agency_name`**.
- `avatar`: profile photo/logo where one exists, as a resolved **file object** (`{ id, key, url, mimeType, size, originalName }`) — **agency → resolved from `logo_file_id`** — otherwise `null`.
- Unresolvable references fall back to the capitalised role name (e.g. `"Agency"`) with `avatar: null`.

**Entity summary** (ticket `entity` field):
```json
{ "type": "SHIPMENT", "id": "string", "label": "Shipment a1b2c3", "reference": "string" }
```
- `ORDER`, `PRODUCT`, `BOOKING` are fully resolved (order number / product title+slug / booking date).
- All other types (`SHIPMENT`, `DELIVERY`, `USER`, `VENDOR`, `CUSTOMER`, `AGENT`, `AGENCY`, `OTHER`)
  degrade to a generic label built from the type name and the last 6 characters of the id.

### Ticket Status Values

```
open → in_progress → waiting_on_<role> → resolved → closed
                     (admin | vendor | customer | agency | agent)
```

| Status | Description |
|---|---|
| `open` | Ticket created, awaiting action |
| `in_progress` | Actively being worked on |
| `waiting_on_admin` | Waiting for admin action |
| `waiting_on_vendor` | Waiting for vendor response |
| `waiting_on_customer` | Waiting for customer response |
| `waiting_on_agency` | Waiting for delivery agency response |
| `waiting_on_agent` | Waiting for delivery agent response |
| `resolved` | Issue resolved, awaiting confirmation |
| `closed` | Ticket closed, no further action |

### Priority Locking

- Priority values: `low`, `normal`, `high`, `urgent`.
- When an **admin** sets priority, it locks permanently — only that active admin can change it again.
- Non-admin priority updates (including from an agency) never lock the ticket.

### Exclusive Admin Locking

- The first admin to act on a ticket becomes its **active admin**; only they can act on it further.
- Other admins can view metadata but not perform actions until the lock clears.
- Auto-unlocks when the ticket is **closed** or **resolved**.

### Visibility Controls

**Notes**: `public` (visible to all followers) or `private` (visible to author, all admins, and an explicit user list).

**Attachments**: `PUBLIC` (default, visible to all followers) or `PRIVATE` (visible to uploader, all admin followers, and an explicit user list). Note the **case difference** from note visibility.

### Attachment Limits

- Maximum 5 attachments per ticket, immutable after upload.
- Only admins can delete attachments.

### Follower System

- Ticket creator is auto-added as a follower on creation.
- Assigning a ticket to a specific user also adds them as a follower.
- Maximum 5 non-admin followers per ticket (lifetime limit); admins don't count toward this limit.
- Only admins can remove followers.

### Entity References

`entityType` values relevant to an agency: `ORDER`, `SHIPMENT`, `DELIVERY`, `AGENCY`, `AGENT`,
`PRODUCT`, `OTHER` (any value in the full enum is accepted — see the Ticket Types section above
for how existence validation and support-policy enforcement differ by type).

### Timestamps

All timestamp fields are returned in ISO 8601 format, e.g. `2026-07-05T19:00:00.000Z`.
