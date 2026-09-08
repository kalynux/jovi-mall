# Vendor Tickets

**Verified against source on 2026-09-08** — R7 re-counted all four enums from source and every figure is exact — **39** `TicketType`, **9** `TicketStatus`, **4** `TicketPriority`, **11** `EntityType` (`modules/tickets/types/ticket.types.ts:10,74,89,120`) — re-confirmed the `max(5)` attachment cap (`validators/ticket.validator.ts:61`), and re-checked the guard claims: the follower check on `PATCH /:id/priority` is present (`services/ticket.service.ts:421-425`, added 2026-09-07) exactly as the note below says, and the three routes it lists as still unguarded still are. No defects found.

**Re-verified against source on 2026-09-08** — the enum sizes (39 `TicketType`, 9 `TicketStatus`,
11 `EntityType`, 4 `TicketPriority`) and, in particular, **every open-defect box on this page**,
against `src/modules/tickets/`. Two of them had been fixed since 2026-09-06 and were still being
reported as live: the missing follower check on `PATCH /:id/priority`
(`ticket.service.ts:422-423`) and the `admin_assignment` / `tier` disclosure
(`ticket-enrichment.service.ts:189`). `PATCH /:id/assign` (`:254-255`) and `POST /:ticketId/notes`
(`ticket-note.service.ts:65-66`) are also guarded now. **Three routes are still unguarded** —
`GET /:ticketId/notes`, `GET`/`POST /:ticketId/attachments`.

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–26). Corrections are marked inline with ⚠ and a source citation.

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
  "subject": "string (required, min 1, max 200 chars) - Ticket subject/title",
  "description": "string (required, min 1, max 700 chars) - Detailed description",
  "type": "string (required) - Ticket type. One of the 39 UPPERCASE TicketType values — see ../ticket_types.txt",
  "importance": "string (required) - Importance level. Enum: low, medium, high, critical",
  "entityType": "string (required) - Related entity type. UPPERCASE. Enum: ORDER, PRODUCT, BOOKING, SHIPMENT, DELIVERY, USER, VENDOR, CUSTOMER, AGENT, AGENCY, OTHER",
  "entityId": "string (optional for `OTHER`, required otherwise) - ID of the related entity (e.g., order ID). For `OTHER`, defaults to the requester's own id.",
  "trackingNumber": "string (optional, max 120) - Required only for ORDER tickets when the vendor's support policy lists `tracking_number`",
  "attachments": "string[] (optional, max 5) - File ids previously uploaded via POST /api/files/upload; required for ORDER/PRODUCT tickets when the vendor's support policy lists `product_photo_video`"
}
```

> **Attachments provided at creation are persisted.** Each file id in `attachments`
> is attached to the new ticket exactly as if posted to
> `POST /api/vendor/tickets/:ticketId/attachments` — an attachment record is
> created and a `file_references` row registered (so the file is not
> garbage-collected). They are returned by
> `GET /api/vendor/tickets/:ticketId/attachments`, not inline in the create
> response. Each must be a file you own (or a system file); the 5-attachment cap
> applies. (Previously, attachments sent at creation were silently dropped.)

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
    "id": "string",
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
      "avatar": null
    },
    "assigned_to_role": null,
    "assigned_to": null,
    "admin_assignment": null,
    "assigned_admin": null,
    "priority_locked": false,
    "followers": [
      {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar": null
      }
    ],
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  }
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
> `/api/internal/admin/tickets` (admin is unscoped).

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
      "customerAvatar": {
        "id": "664file...", "key": "images/2026/07/664file....png",
        "url": "https://.../avatar.png", "mimeType": "image/png",
        "access": "public",
        "size": 24576, "originalName": "avatar.png"
      },
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

> - `customerName` / `customerAvatar` are the picker's primary row label and thumbnail; both `null` when the customer profile cannot be resolved. **`customerAvatar` is a resolved FileDetail object** (`{ id, key, url, access, mimeType, size, originalName }`), never a URL string — the platform-wide convention.
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

**Description**: List every ticket the vendor **follows** — not only the ones they created — with filters, sorting and pagination. The creator is added as a follower automatically, so their own tickets are always included; a ticket somebody added them to is included too. There is no `q` search (see below). `findVisibleToUser` (`ticket.repository.ts:170`) joins `ticket_followers` and matches on membership.

> ⚠ **This page said "created by the vendor", and that is narrower than what the endpoint returns.** A vendor added as a follower to an agency's or a customer's ticket sees it here.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `status` (string, optional) - Filter by status. Enum: `open`, `in_progress`, `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_customer`, `waiting_on_agency`, `waiting_on_agent`, `resolved`, `closed`
- `priority` (string, optional) - Filter by priority. Enum: `low`, `normal`, `high`, `urgent`
- `type` (string, optional) - Filter by type. Any `TicketType` value (UPPERCASE) — see [../ticket_types.txt](../ticket_types.txt)
- `entityType` (string, optional) - Filter by entity type. UPPERCASE: `ORDER`, `PRODUCT`, `BOOKING`, `SHIPMENT`, `DELIVERY`, `USER`, `VENDOR`, `CUSTOMER`, `AGENT`, `AGENCY`, `OTHER`
- ~~`q` (string, optional, max 100 chars) - Search query (subject, description)~~ — **there is
  no `q` on this endpoint.** `ListTicketsQuerySchema` (`ticket.validator.ts:145-163`) has no
  such key and is not `.strict()`, so one sent anyway is **silently stripped** and the full
  unfiltered list comes back. Filter client-side, or narrow with `type` / `status` /
  `entityType`. (The `q` on `reference/orders` and `reference/products` above is real and
  unrelated.)
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 100) - Items per page
- `sortBy` (string, optional, default: `createdAt`) - Sort field. Enum: `createdAt`, `updatedAt`, `priority`, `status`
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
      "id": "string",
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
        "avatar": null
      },
      "assigned_to_role": "admin",
      "assigned_to": null,
      "admin_assignment": {
        "admin": {
          "id": "string",
          "source": "admin",
          "name": "Kofi Mensah",
          "tier": 3,
          "job_title": "Support lead",
          "department": "Customer Care",
          "avatar_url": null
        },
        "assigned_by": null,
        "assigned_at": "2026-02-11T19:20:00.000Z"
      },
      "assigned_admin": {
        "name": "Kofi Mensah",
        "job_title": "Support lead",
        "department": "Customer Care",
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
    "id": "string",
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
      "avatar": null
    },
    "assigned_to_role": "admin",
    "assigned_to": null,
    "admin_assignment": {
      "admin": {
        "id": "string",
        "source": "admin",
        "name": "Kofi Mensah",
        "tier": 3,
        "job_title": "Support lead",
        "department": "Customer Care",
        "avatar_url": null
      },
      "assigned_by": null,
      "assigned_at": "2026-02-11T19:20:00.000Z"
    },
    "assigned_admin": {
      "name": "Kofi Mensah",
      "job_title": "Support lead",
      "department": "Customer Care",
      "avatar_url": null
    },
    "priority_locked": true,
    "followers": [
      {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar": null
      },
      {
        "user_id": "string",
        "role": "agent",
        "name": "Lena Park",
        "avatar": null
      }
    ],
    "createdAt": "2026-02-11T19:00:00.000Z",
    "updatedAt": "2026-02-11T19:00:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found. ⚠ Not `NOT_FOUND` — that code is reserved for unmatched routes (`error-codes.ts:1531`)

---

### PATCH /api/vendor/tickets/:id

**Description**: Update ticket subject and/or description. **Any follower may** — not only the
creator.

> ⚠ **This page said "only the ticket creator" for both this route and the shape of every write
> response, and both were wrong.** Two corrections that apply to all five write routes on this
> page (`PATCH /:id`, `/:id/status`, `/:id/assign`, `/:id/priority`, `POST /:id/close`):
>
> 1. **The permission is FOLLOWERSHIP, not authorship** (`ticket.service.ts:521-526` — the thrown
>    message is literally *"Only ticket followers can update tickets"*). The creator is a
>    follower automatically, so the old sentence was right about the common case and wrong about
>    the rule. `POST /:id/close` is the one exception and really is creator-or-admin
>    (`ticket.service.ts:457`).
> 2. **Every write returns the WHOLE ticket document, un-enriched**, not the three or four fields
>    the examples below show (`res.status(200).json({ success: true, data: updatedTicket })`).
>    Un-enriched matters: `assigned_admin`, `created_by`, `entity` and `followers` are added by
>    `TicketEnrichmentService`, which runs on **create, list and detail only** — so a write
>    response carries `admin_assignment` and `created_by_user_id` and none of the resolved blocks.
>    The abridged examples below show the fields that *changed*; read the full shape from
>    `GET /:id`.
>
> **There is no `message` key on any write response on this surface.** The only two ticket
> endpoints that send one are the follower add/remove pair, which is not on the vendor mount.

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
  "subject": "string (optional, min 1, max 200 chars) - New subject",
  "description": "string (optional, min 1, max 10000 chars) - New description"
}
```

> ⚠ **The two description limits differ, in the code, and this is not a typo in the doc.**
> Create caps `description` at **700** characters; this update endpoint caps it at **10000**.
> At least one of `subject` / `description` must be present.

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
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Not a follower of this ticket (the message is “Only ticket followers can update tickets”)
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
    "id": "string",
    "status": "waiting_on_admin",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Only ticket followers can update status
- `400` – `VALIDATION_ERROR` – The `status` value is not one of the allowed enum members
- `400` – `TICKET_INVALID_STATUS_TRANSITION` – **The ticket is already in that status.** ⚠ **This is the only transition that is refused.** There is no state machine here: `validateStatusTransition` is three lines and its own comment says *"Allow any transition for now"* (`ticket.service.ts:680-686`), rejecting only `from === to` with *"Status is already set to this value"*. `closed → open`, `resolved → open`, any order at all — all legal.
- `400` – `TICKET_WAITING_TARGET_NOT_PARTICIPANT` – A `waiting_on_<role>` status was requested but no participant with that role is on the ticket (does not apply to `waiting_on_admin`)

> ⚠ **This block said "`VALIDATION_ERROR` – Invalid status value **or invalid state transition**"
> until 2026-09-06**, which reads as though a transition table exists and is enforced. It does
> not. Two consequences for a client: **do not pre-validate transitions against a state machine
> you infer from this page** — you will block moves the server allows — and **branch on
> `TICKET_INVALID_STATUS_TRANSITION`, not `VALIDATION_ERROR`**, for the one case that is
> refused. A UI that greys out "reopen" on a closed ticket is enforcing a rule the backend does
> not have.

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
  "targetRole": "string (required) - Role to assign to. Enum: admin, vendor, customer, agency, agent",
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
    "id": "string",
    "assigned_to_role": "admin",
    "admin_assignment": null,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
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
  "priority": "string (required) - New priority. Enum: low, normal, high, urgent"
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
    "priority": "high",
    "priority_locked": false,
    "updatedAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `409` – `TICKET_CLOSED` – *"Cannot update priority of a closed ticket."* Checked **before** the lock, so a closed ticket answers this whatever its `priority_locked` says
- `403` – `TICKET_PRIORITY_LOCKED` – Priority is locked by an admin and cannot be modified. ⚠ There is no `PRIORITY_LOCKED` in the registry
- `400` – `VALIDATION_ERROR` – Invalid priority value

> ✅ **The follower check is now present — re-verified 2026-09-08.** This box said the route had
> none. `TicketService.updatePriority` calls `followerService.isFollower` at
> `ticket.service.ts:422-423` and refuses a non-follower, so a `403` on someone else's ticket is
> now the expected answer rather than a silent success. Order of guards: ticket lookup → closed →
> **follower** → locked.

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
    "id": "string",
    "status": "closed",
    "updatedAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `403` – `TICKET_ACCESS_DENIED` – Only the ticket creator or an admin can close a ticket

---

### POST /api/vendor/tickets/:ticketId/notes

**Description**: Create a note on a ticket. Vendors can create `public` notes or `private` notes visible to specific users. Requires **followership** (`403 TICKET_ACCESS_DENIED`) and an open ticket (`409 TICKET_CLOSED`).

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
  "content": "string (required, min 1, max 300 chars) - Note content",
  "visibility": "string (optional, default: public) - Enum: public, private",
  "visibleToUserIds": "array of strings (optional, default []) - User IDs who can see a private note"
}
```

> ⚠ **The field is `content`, not `message`**, and note visibility is **lowercase**
> (`public` / `private`) — while **attachment** visibility on
> `POST /api/vendor/tickets/:ticketId/attachments` is **UPPERCASE** (`PUBLIC` / `PRIVATE`).
> The two validators genuinely disagree; send each exactly as written here.

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
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
      "avatar": null
    },
    "visible_to_user_ids": [],
    "created_at": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `TICKET_NOT_FOUND` – Ticket not found
- `409` – `TICKET_CLOSED` – *"Cannot add notes to a closed ticket."* Reopen it first
- `403` – `TICKET_ACCESS_DENIED` – *"Only ticket followers can create notes"*
- `400` – `VALIDATION_ERROR` – Invalid `content` or visibility parameters

---

### GET /api/vendor/tickets/:ticketId/notes

**Description**: Get all notes for a ticket. Vendors see `public` notes + their own `private` notes + `private` notes they are included in. ⚠ **No followership is checked on this route** — the visibility filter is per-note, and a non-follower holding the `ticketId` reads every `public` note on it. Reported as a backend defect.

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
        "avatar": { "id": "…", "key": "images/2026/07/kofi.png", "url": "https://.../images/2026/07/kofi.png", "access": "public", "mimeType": "image/png", "size": 15360, "originalName": "kofi.png" }
      },
      "visible_to_user_ids": [],
      "created_at": "2026-02-11T19:30:00.000Z"
    },
    {
      "id": "string",
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
        "avatar": { "id": "…", "key": "images/2026/07/kofi.png", "url": "https://.../images/2026/07/kofi.png", "access": "public", "mimeType": "image/png", "size": 15360, "originalName": "kofi.png" }
      },
      "visible_to_user_ids": ["admin1", "admin2"],
      "created_at": "2026-02-11T19:31:00.000Z"
    }
  ]
}
```

**Error Responses**:
- ~~`404` – `TICKET_NOT_FOUND` – Ticket not found~~ — **UNREACHABLE.** This route performs no ticket lookup at all; an unknown `ticketId` returns an empty list, and there is no follower check either. Reported as a backend defect; **still open, re-verified 2026-09-08.**

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

> ⚠ **`visibility` controls who is shown the attachment *row*, not who can fetch the bytes.**
> A ticket attachment is an ordinary `POST /api/files/upload` that lands in the **public**
> `images/` or `documents/` tree — the same folders as public product imagery — and is attached
> to the ticket by id afterwards. Its `url` is therefore a plain public URL, and a `PRIVATE`
> attachment's URL is still fetchable by anyone who has it.
>
> This is a **known open gap**, named in `docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`: closing it needs
> a dedicated ticket-attachment upload path writing to a private folder, an authorized read
> reusing the ticket's scope, and a migration for existing rows. **None of that exists yet.**
> Phase 4 made delivery-proof photos and digital products private
> ([FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md)); it did **not**
> close this one. Do not promise attachment privacy in product copy.

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
    "url": "http://localhost:8022/api/files/images/2026/02/a1b2c3…_checkout-error.png",
    "uploadedBy": "string",
    "uploadedByRole": "vendor",
    "uploadedByActor": {
      "user_id": "string",
      "role": "vendor",
      "name": "Acme Store",
      "avatar": null
    },
    "createdAt": "2026-02-11T19:30:00.000Z"
  }
}
```

**Error Responses**:
- ~~`404` – `TICKET_NOT_FOUND` – Ticket not found~~ — **UNREACHABLE.** `TicketAttachmentService.attachFile` (`ticket-attachment.service.ts:65`) never loads the ticket, so an unknown `ticketId` attaches the file to a ticket that does not exist. No follower check either. Reported as a backend defect; **still open, re-verified 2026-09-08** (unlike the priority and assign routes, which have since been fixed).
- `404` – `TICKET_ATTACHMENT_MISSING` – `fileId` does not reference an existing file
- `403` – `TICKET_ACCESS_DENIED` – The file belongs to another user (only the file owner or an admin can attach it)
- `422` – `TICKET_ATTACHMENT_LIMIT_EXCEEDED` – Maximum 5 attachments per ticket reached
- `400` – `VALIDATION_ERROR` – Missing/invalid `fileId` or visibility parameters

---

### GET /api/vendor/tickets/:ticketId/attachments

**Description**: List all attachments for a ticket. Vendors see `PUBLIC` attachments + their own `PRIVATE` attachments + `PRIVATE` attachments they are included in. ⚠ **No followership is checked on this route either** — same defect as the notes list.

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
      "url": "http://localhost:8022/api/files/images/2026/02/a1b2c3…_checkout-error.png",
      "uploadedBy": "string",
      "uploadedByRole": "vendor",
      "uploadedByActor": {
        "user_id": "string",
        "role": "vendor",
        "name": "Acme Store",
        "avatar": null
      },
      "createdAt": "2026-02-11T19:30:00.000Z"
    }
  ]
}
```

**Error Responses**:
- ~~`404` – `TICKET_NOT_FOUND` – Ticket not found~~ — **UNREACHABLE.** This route performs no ticket lookup at all; an unknown `ticketId` returns an empty list, and there is no follower check either. Reported as a backend defect; **still open, re-verified 2026-09-08.**

---

## Notes & Constraints

### Populated / Enriched References

Every endpoint that returns a ticket, note or attachment also resolves the raw
ObjectId references into ready-to-render summary objects. The original `*_id`
fields are **kept** for backward compatibility; the populated objects are added
alongside them, so the frontend never has to issue follow-up lookups to display
a name, avatar or entity label.

**Actor summary** — used for `created_by`, `assigned_to`,
each entry in `followers`, the note `author`, and the attachment
`uploadedByActor`. **`assigned_admin` is NOT one of these** — it has its own shape, below:

```json
{
  "user_id": "string",
  "role": "vendor",
  "name": "Acme Store",
  "avatar": { "id": "…", "key": "images/2026/07/logo.png", "url": "https://.../images/2026/07/logo.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" }
}
```

- `name` is resolved per role: admin/customer/agent → `name`; **vendor → `Vendor.display_name`, falling back to `Store.name`**; **agency → `DeliveryAgency.display_name`, falling back to `Magazin.name`** (`ticket-enrichment.service.ts:302, 354`).
  > ⚠ **This line said the fallbacks were `business_name` and `agency_name` until 2026-09-06.
  > Neither field exists on those profiles.** The business identity — name *and* logo — lives on
  > the **Store** (vendor) and the **Magazin** (agency), never on the profile, which holds only
  > `display_name` and an avatar. So the fallback is a lookup into a *different collection*, and
  > a vendor with no `display_name` and no Store row resolves to **`''`**, an empty string —
  > **not `null`**. Test for empty, not for null.
- `avatar` is a resolved **file object** (`{ id, key, url, access, mimeType, size, originalName }`, the same shape product images use), otherwise `null`. ⚠ For a vendor or agency this is the **Store/Magazin logo** (`logo_file_id`), not a personal profile photo — the same split as `name`.
- If a reference cannot be resolved (deleted profile, etc.), `name` falls back to the capitalised role (e.g. `"Vendor"`) and `avatar` is `null`.
- A `null` value (e.g. `assigned_to: null`, `assigned_admin: null`) means the corresponding `*_id` is unset.

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
- **`assigned_admin` itself carries no `tier` and no `id`.** `publicAdminSnapshot`
  (`core/types/admin-snapshot.types.ts:110`) projects `name` / `job_title` / `department` /
  `avatar_url` and drops the rest, and the hierarchy is deliberately not disclosed to a ticket
  follower.

  ✅ **The response now keeps that promise — re-verified 2026-09-08.** This block used to record
  the opposite: `TicketEnrichmentService` built its payload with `toObject({ virtuals: true })`
  and never deleted the raw `admin_assignment`, so `.id`, `.source` and `.tier` reached every
  follower. It now ends with `delete obj.admin_assignment`
  (`ticket-enrichment.service.ts:189`), and the field is **absent from the wire**. Render from
  `assigned_admin`; a client reading `admin_assignment` gets `undefined`, not stale data.

- `admin_assignment.admin.id` is an `admin_accounts._id` in the **administration service**.
  **It resolves to nothing here** — there is no cross-database join at any price — so treat it
  as opaque or ignore it. `assigned_by` is `null` when an administrator claimed the ticket from
  the pool rather than being handed it, which is a real distinction and not a missing value.

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
- **Any** administrator can re-update a locked priority — the check is `role !== 'admin'`
  (`ticket.service.ts:400-404`), not an identity comparison. *Which* administrator is
  wi-admin's decision (`resolveScope('tickets')` plus the tier matrix), never a lock on
  this row

### ~~Exclusive Admin Locking~~ — REMOVED, and it never worked the way this said

**This mechanism does not exist.** The section below is kept, struck through, because a client
built against it may still be branching on the shape it described.

- ~~When an admin performs the **first action** on a ticket, they become the **active admin**~~
- ~~While locked, **only the active admin** can perform actions on the ticket~~
- ~~Other admins can view metadata but cannot perform actions~~
- ~~Auto-unlocks when ticket is **closed** or **resolved**~~

What replaced it, from `ticket.model.ts:99-110`: the column was `assigned_admin_id`, and it
was never an assignment — `setActiveAdminIfNotSet` stamped it on an administrator's *first
action* and `validateActiveAdminPermission` then answered 403 to every other administrator,
Developers included. A Support administrator merely opening a ticket locked a Developer out of
it, which is the opposite of the tier model wi-admin enforces. **The column, the lock and the
whole `/api/admin/tickets` mount that depended on it are gone.** Administrators now reach
tickets through wi-admin only, and what they may see is decided there by tier.

⚠ **`assigned_admin_id` is not on the wire.** The field on the document is **`admin_assignment`**
(see [Populated / Enriched References](#populated--enriched-references)); the rendered profile
beside it is `assigned_admin`. A client reading `assigned_admin_id` reads `undefined`.

### Visibility Controls

**Notes:**
- `public` - Visible to all ticket followers
- `private` - Visible to author, all admins, and explicit user list

> ⚠ **Note visibility is LOWERCASE and attachment visibility is UPPERCASE.** `NoteVisibility`
> is `'public' | 'private'` (`ticket.types.ts:137-140`) while the attachment validator is
> `z.enum(['PUBLIC','PRIVATE'])` (`ticket-attachment.validator.ts:14`). The two validators
> genuinely disagree; send each exactly as written.

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

Tickets must be associated with a related entity. The `EntityType` enum is **eleven UPPERCASE
values** (`ticket.types.ts:120-132`), and `account` is **not** one of them:

`ORDER` · `PRODUCT` · `BOOKING` · `SHIPMENT` · `DELIVERY` · `USER` · `VENDOR` · `CUSTOMER` ·
`AGENT` · `AGENCY` · `OTHER`

> ⚠ **This section used to list five lowercase values, four of which do not exist.** `order`,
> `product`, `booking` and `account` are all `400 VALIDATION_ERROR` on `entityType` — the
> validator is `z.enum(ENTITY_TYPE_VALUES)`, spread straight from the enum above. The create
> body at the top of this page has always had the right list; this summary contradicted it.
> Only `ORDER`, `PRODUCT` and `BOOKING` are fully resolved into an `entity` block; the other
> eight degrade to a generic label.

`ORDER` / `PRODUCT` / `BOOKING` additionally require the `entityId` to exist
(`404 TICKET_ENTITY_NOT_FOUND`). `OTHER` is the only type for which `entityId` is optional.

### Timestamps

All timestamp fields are returned in ISO 8601 format:
```
2026-02-11T19:00:00.000Z
```
