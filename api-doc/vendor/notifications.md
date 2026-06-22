# Vendor Notifications

## Base Path

All endpoints in this document share this base path:

```
/api/vendor
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### GET /api/vendor/notifications

**Description**: List vendor notifications with optional filtering and pagination. Results are ordered by creation date (newest first).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `isRead` (string, optional) - Filter by read status. Values: `true`, `false`
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 50) - Items per page

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
      "type": "order.created",
      "title": "New Order Received",
      "message": "You have received a new order #ORD-12345",
      "isRead": false,
      "deliveredVia": ["in_app", "email"],
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ],
  "unreadCount": 5,
  "meta": {
    "total": 50,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid query parameters (e.g., limit exceeds maximum)

---

### PATCH /api/vendor/notifications/:id/read

**Description**: Mark a single notification as read.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Notification ID (24-character hexadecimal)

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
    "type": "order.created",
    "title": "New Order Received",
    "message": "You have received a new order #ORD-12345",
    "aggregateType": "order",
    "aggregateId": "string",
    "deliveredVia": ["in_app", "email"],
    "isRead": true,
    "readAt": "2026-02-09T23:55:00.000Z",
    "createdAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Notification marked as read"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Notification not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid notification ID format

---

### POST /api/vendor/notifications/read-all

**Description**: Mark all vendor notifications as read (bulk operation).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "count": 12
  },
  "message": "Marked 12 notification(s) as read"
}
```

**Error Responses**: None

---

### GET /api/vendor/notification-preferences

**Description**: Retrieve vendor notification preferences including channel enablement and event subscriptions.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "inAppEnabled": true,
    "emailEnabled": true,
    "telegramEnabled": false,
    "whatsappEnabled": false,
    "emailVerified": true,
    "telegramVerified": false,
    "whatsappVerified": false,
    "preferences": {
      "orderCreated": true,
      "orderCancelled": true,
      "bookingCreated": true,
      "bookingCancelled": true,
      "paymentReceivedPartial": true,
      "paymentReceivedFull": true,
      "storageAlert": true
    }
  }
}
```

**Error Responses**: None

---

### PATCH /api/vendor/notification-preferences

**Description**: Update notification preferences. All fields are optional.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**: None

**Query Parameters**: None

**Request Body**:
```json
{
  "emailEnabled": "boolean (optional) - Enable email notifications",
  "telegramEnabled": "boolean (optional) - Enable Telegram notifications",
  "whatsappEnabled": "boolean (optional) - Enable WhatsApp notifications",
  "preferences": {
    "orderCreated": "boolean (optional)",
    "orderCancelled": "boolean (optional)",
    "bookingCreated": "boolean (optional)",
    "bookingCancelled": "boolean (optional)",
    "paymentReceivedPartial": "boolean (optional)",
    "paymentReceivedFull": "boolean (optional)",
    "storageAlert": "boolean (optional) - Alerts when media storage nears the plan limit"
  }
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "inAppEnabled": true,
    "emailEnabled": true,
    "telegramEnabled": false,
    "whatsappEnabled": false,
    "emailVerified": true,
    "telegramVerified": false,
    "whatsappVerified": false,
    "preferences": {
      "orderCreated": true,
      "orderCancelled": true,
      "bookingCreated": false,
      "bookingCancelled": false,
      "paymentReceivedPartial": true,
      "paymentReceivedFull": true,
      "storageAlert": true
    }
  },
  "message": "Preferences updated successfully"
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

## Notes & Constraints

### Notification Types

Supported notification types. The `type` value is **dot-delimited** (match on these exact strings):

| Type | `aggregateType` | Description |
|------|------|-------------|
| `order.created` | `order` | New order received |
| `order.cancelled` | `order` | Order was cancelled |
| `booking.created` | `booking` | New service booking received |
| `booking.cancelled` | `booking` | Service booking was cancelled |
| `payment.received.partial` | `payment` | Partial payment received |
| `payment.received.full` | `payment` | Full payment received |
| `storage.alert` | `storage` | Media storage usage crossed a threshold (80% / 90% / 100% of the plan limit). `aggregateId` is the vendor's id. See [Storage](./storage.md). |

### Delivery Channels

Notifications can be delivered via multiple channels:

| Channel | Description | Requires Verification |
|---------|-------------|----------------------|
| `in_app` | Platform notifications (always enabled) | No |
| `email` | Email notifications | Yes |
| `telegram` | Telegram notifications | Yes |
| `whatsapp` | WhatsApp notifications | Yes |

### Channel Verification Status

The `emailVerified`, `telegramVerified`, and `whatsappVerified` fields indicate whether the vendor has verified the respective channel:
- `true` - Channel is connected and verified
- `false` - Channel is not connected or not verified

Enabling a channel that is not verified (`*Enabled: true` but `*Verified: false`) will have no effect until the channel is verified.

### Priority Order

When multiple channels are enabled, the system uses this priority order:
1. Email (highest priority)
2. Telegram
3. WhatsApp

If email is enabled and verified, other channels are automatically disabled.

### In-App Notifications

In-app notifications (`inAppEnabled`) are always `true` and cannot be disabled. All notifications are always stored and accessible via `GET /notifications` regardless of other channel settings.

### Event Preferences

The `preferences` object allows vendors to subscribe/unsubscribe from specific event types. Setting an event to `false` prevents notifications for that event across all channels.

### Notification ID Format

Notification IDs are 24-character hexadecimal strings (MongoDB ObjectId format). Invalid formats will return `VALIDATION_ERROR`.

### Read Status Behavior

- Marking a notification as read sets `isRead: true` and `readAt` to the current timestamp
- Marking an already-read notification as read is idempotent (no error, returns same result)
- The `unreadCount` in list responses reflects only unread notifications

### Pagination Limits

The `limit` parameter for listing notifications has a maximum value of `50` (lower than the standard `100` for other endpoints).

### Aggregate References

Notifications include `aggregateType` and `aggregateId` fields that reference the related entity:
- `aggregateType: "order"` with `aggregateId: "..."` links to an order
- `aggregateType: "booking"` with `aggregateId: "..."` links to a booking
- `aggregateType: "payment"` with `aggregateId: "..."` links to a payment
- `aggregateType: "storage"` with `aggregateId: "<vendorId>"` — a storage alert; deeplink to the storage/usage screen (see [Storage](./storage.md))

These fields are useful for deeplinks in the frontend.

### Immutable Fields

Notifications cannot be edited or deleted. The only mutable field is `isRead`.
