# Agency Tickets

**Verified against source on 2026-09-08** — all 14 routes, the `id`-vs-`_id` identifier rule (`core/base.schema.ts` + `TicketEnrichmentService.toObject`), and the agency actor-name resolution `display_name || Magazin.name || ""`, against `jovi-mall/src/modules/tickets/`.

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
> `/api/internal/admin/tickets`, scoped to the caller's role. Mechanics (follower system, priority locking,
> visibility rules) are identical across roles; this document lists the **current, authoritative**
> enum values from `src/modules/tickets/types/ticket.types.ts`. The full `TicketType` list is also
> kept as a flat file at [../ticket_types.txt](../ticket_types.txt).

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
    "id": "string",
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
      "avatar": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/fasttrack-logo.png", "url": "https://cdn.example.com/fasttrack-logo.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" }
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
        "avatar": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/fasttrack-logo.png", "url": "https://cdn.example.com/fasttrack-logo.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" }
      }
    ],
    "createdAt": "2026-07-05T19:00:00.000Z",
    "updatedAt": "2026-07-05T19:00:00.000Z"
  }
}
```

> **Actor summary for `agency`.** `name` resolves to **`DeliveryAgency.display_name`, falling back
> to `Magazin.name`** (`ticket-enrichment.service.ts:355`), and `avatar` to the resolved logo
> **file object** (from the **Magazin's** `logo_file_id`) — used for `created_by`, `assigned_to`,
> and every entry in `followers` when the actor is an agency.
> ⚠ **This said `name` resolves to `agency_name` until 2026-09-06; there is no such field on the
> agency profile.** The business name lives on the **Magazin**, the profile holds only
> `display_name` — so the fallback is a lookup into another collection, and an agency with
> neither resolves to **`''`**, not `null`.
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
      "id": "string",
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
        "name": "Kofi Mensah",
        "job_title": "Support lead",
        "department": "Customer Care",
        "avatar_url": null
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
> (`/api/internal/admin/tickets/:id/reopen`).

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
    "id": "string",
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
    "url": "http://localhost:8022/api/files/images/2026/02/a1b2c3…_checkout-error.png",
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

**Actor summary** (`created_by`, `assigned_to`, each `followers` entry, note `author`,
attachment `uploadedByActor`). **`assigned_admin` is NOT one of these** — it has its own shape,
below:
```json
{ "user_id": "string", "role": "agency", "name": "FastTrack Logistics", "avatar": { "id": "…", "key": "images/2026/07/logo.png", "url": "https://.../images/2026/07/logo.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" } }
```
- `name`: admin/customer/agent → `name`; **vendor → `Vendor.display_name`, falling back to
  `Store.name`**; **agency → `DeliveryAgency.display_name`, falling back to `Magazin.name`**
  (`ticket-enrichment.service.ts:302, 355`). ⚠ **The fallbacks read `business_name` and
  `agency_name` until 2026-09-06 and neither field exists** — business identity lives on the
  Store/Magazin, the profile holds only `display_name`. With both absent the value is **`''`**,
  not `null`.
- `avatar`: profile photo/logo where one exists, as a resolved **file object** (`{ id, key, url, access, mimeType, size, originalName }`) — **agency → resolved from `logo_file_id`** — otherwise `null`.
- Unresolvable references fall back to the capitalised role name (e.g. `"Agency"`) with `avatar: null`.

**Administrator snapshot** — used for `assigned_admin` and `created_by_admin`:

```json
{ "name": "Kofi Mensah", "job_title": "Support lead", "department": "Customer Care", "avatar_url": null }
```

**This is NOT the actor summary above, and it changed.** It used to be
`{ user_id, role, name, avatar }`; it is now the four fields shown. Nothing broke when it
changed, because it is `null` on almost every ticket — see below — which is exactly how a
documented shape goes stale unnoticed.

- `assigned_admin` is **`null` until a wi-admin administrator takes the ticket.** Support
  administrators live in a separate service with its own database, so nobody is assigned by
  default and most tickets never are. `null` is the normal state, not missing data.
- `created_by_admin` is non-null only when an administrator opened the ticket **for** you.
  When they did, `created_by` is also present with `role: "admin"` — but its `user_id` is an
  administrator id from the other service, which resolves nowhere here, and its `avatar` is
  always `null`. Render the person from this block, not from that one.
- **`avatar_url` is reserved and always `null`.** Administrators have no picture: there is no
  upload surface for one and no storage decision has been made. Draw the initials from `name`
  and do not branch on this field. It is carried so that the day an avatar exists, nothing
  about this shape changes.
- `job_title` and `department` are free text and may each be `null`.
- **No `tier`, no `id`.** The administrator hierarchy is internal and is deliberately not
  disclosed to a ticket follower.
- `assigned_admin_id` beside it is an id in the administration service. **It resolves to
  nothing here** — treat it as opaque, or ignore it and read this block.

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
