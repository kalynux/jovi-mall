# WhatsApp API

These are the core endpoints implemented in the WhatsApp module. The router is mounted at
**`/api/webhooks/whatsapp`** (`src/api/index.ts`) — the module lives in
`src/modules/whatsapp/`, but there is no `/api/whatsapp` prefix.

| Endpoint | Auth |
|---|---|
| `POST /api/webhooks/whatsapp/` | none (public webhook) |
| `GET /api/webhooks/whatsapp/link/status` | required |
| `DELETE /api/webhooks/whatsapp/link` | required |

Because it lives under `/api/webhooks`, the whole prefix — including the two authenticated link
routes — is **exempt from rate limiting** ([rate-limits.md](../rate-limits.md)) and stays
reachable during a maintenance window unless the operator set `blockWebhooks` on that window.

## 1. Webhook (Inbound Messages)

This endpoint receives inbound messages sent to the Jovi Mall WhatsApp business number. It is intended to be called by an automation layer (like n8n) rather than directly by frontend applications.

- **Endpoint:** `POST /api/webhooks/whatsapp/`
- **Authentication:** None (Public)
- **Role Requirements:** None
- **Content-Type:** `application/json`

### Request Body

```json
{
  "reply_to": "1234567890", // The WhatsApp Phone ID of the user sending the message
  "wa_phone_id": "1234567890", // (Optional) Additional Phone ID
  "user_id": "abc123xyz...", // (Optional) Known user_id if already resolved by n8n
  "is_command": true, // Set to true if a /command was detected
  "command": "link", // The detected command name (without the slash)
  "payload": {
    "code": "A1B2C3D4",
    // Handlers may require injected payload structures, for example:
    "wa_data": { 
      "wa_phone_id": "1234567890", 
      "name": "John Doe" 
    }
  } // (Optional) Command payload
}
```

### Response `200`
A dynamic result object returned by the internal CommandBus (or a generic success if no command was present).

> ⚠ This endpoint answers the automation layer, not a frontend, so it is one of the deliberate
> exceptions to the `{ success, data }` envelope — the body below is sent verbatim.

```json
{
  "message": "Inbound recorded",
  // additional keys returned by the specific command handler
}
```

---

## 2. Get Link Status

Retrieves the current WhatsApp linking status for the authenticated user and their currently selected role.

- **Endpoint:** `GET /api/webhooks/whatsapp/link/status`
- **Authentication:** Required (cookie or Bearer token)
- **Role Requirements:** Any (`vendor`, `customer`, `agency`, `agent`)
- **Content-Type:** `application/json`

### Response `200` (Linked)

```json
{
  "success": true,
  "data": {
    "linked": true,
    "wa_phone_id": "1234567890",
    "name": "John Doe",
    "bound_at": "2024-03-01T12:00:00.000Z"
  }
}
```

### Response `200` (Not Linked)

```json
{
  "success": true,
  "data": { "linked": false }
}
```

---

## 3. Unlink Account

Unlinks the WhatsApp account from the authenticated user for their currently selected role. This acts on a _per-role_ basis, stopping only that specific role from utilizing the WhatsApp integration.

- **Endpoint:** `DELETE /api/webhooks/whatsapp/link`
- **Authentication:** Required (cookie or Bearer token)
- **Role Requirements:** Any string matched to a supported role
- **Content-Type:** `application/json`

### Response `200`

```json
{
  "success": true,
  "data": null,
  "message": "WhatsApp account unlinked"
}
```

### Error Responses

**`404 Not Found`** - Account is not currently linked.

```json
{
  "success": false,
  "requestId": "req-1234abc",
  "error": {
    "code": "WHATSAPP_NOT_LINKED",
    "message": "No WhatsApp account linked",
    "statusCode": 404,
    "category": "not_found"
  }
}
```

**`400 Bad Request`** - The active role does not support WhatsApp linking (e.g., `admin`).

```json
{
  "success": false,
  "requestId": "req-1234abc",
  "error": {
    "code": "WHATSAPP_ROLE_NOT_SUPPORTED",
    "message": "This role does not support WhatsApp linking",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "role": "admin"
    }
  }
}
```
