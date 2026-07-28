# Agency Notifications

Full multi-channel parity with vendor notifications — in-app, push, and one preference-gated
secondary channel (email/Telegram/WhatsApp), catalog-driven and localized. Architecture mirrors
[Vendor Notifications](../vendor/notifications.md) exactly; this doc follows the same structure —
read that doc's [Push notifications (FCM)](../vendor/notifications.md#push-notifications-fcm)
section for the full client-side integration guide (Firebase config, service worker,
foreground/background handling), which applies unchanged against `/api/agency/devices`.

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

---

## Notification Settings (build the settings UI from this)

An agency's notification settings are made up of three parts, same as vendor:

1. **Event subscriptions** (`preferences.*`) — per-event on/off. Read/written via the
   **notification-preferences** endpoints below.
2. **Delivery channel** (`*Enabled` + `*Verified`) — which secondary channel receives messages.
   Read/written via the **notification-preferences** endpoints below.
3. **Language** (`preferred_language`) — the language every notification is rendered in. Lives on
   the **agency profile** (see [Notification language](#notification-language)).

### How delivery is decided

- **In-app is always on** and cannot be disabled. Every notification is stored and returned by
  `GET /notifications` regardless of channel settings.
- **At most ONE secondary channel** is active at a time (email **or** telegram **or** whatsapp).
  Enabling one **auto-disables** the others.
- A secondary channel only delivers if it is **both enabled AND verified**. The platform picks the
  first available secondary channel in priority order **telegram → email → whatsapp**.
- An event only notifies if its toggle in `preferences` is `true`.
- The message is rendered in the agency's `preferred_language`.

---

## Endpoints

- [`GET /api/agency/notification-preferences`](#get-preferences)
- [`PATCH /api/agency/notification-preferences`](#update-preferences)
- [`GET /api/agency/notifications`](#list)
- [`PATCH /api/agency/notifications/:id/read`](#mark-read)
- [`POST /api/agency/notifications/read-all`](#mark-all-read)
- [`POST /api/agency/devices`](#register-device)
- [`DELETE /api/agency/devices`](#unregister-device)

---

<a name="get-preferences"></a>
### GET /api/agency/notification-preferences

**Description**: Retrieve the agency's notification settings: channel enablement, live
verification status, and per-event subscriptions.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "inAppEnabled": true,
    "emailEnabled": false,
    "telegramEnabled": true,
    "whatsappEnabled": false,
    "emailVerified": true,
    "telegramVerified": true,
    "whatsappVerified": false,
    "preferences": {
      "connectionUpdated": true,
      "shipmentAssigned": true,
      "payoutUpdates": true,
      "codDepositUpdates": true,
      "planUpdates": true,
      "storageAlert": true
    }
  }
}
```

The `*Verified` flags are **computed live** from the agency's account (email verification,
Telegram link, WhatsApp link) — not stored toggles, ignored on write.

`codDepositUpdates` covers two COD cash-chain situations: an agent **declaring a hand-over** you must
confirm or reject (`cod.deposit.declared`), and an agent **paying the platform directly**, which drops
your liability without you acting (`cod.deposit.direct_to_platform`). Note the declaration one has a
consequence you cannot opt out of: leave a declaration unanswered past the confirm deadline (2 days)
and a `deposit_not_confirmed` discrepancy freezes your rolling-reserve releases. Turning the
notification off does not stop the clock — so surface that in the settings UI.

---

<a name="update-preferences"></a>
### PATCH /api/agency/notification-preferences

**Description**: Update notification settings. All fields optional; send only what changes.

**Request Body** (all optional):
```json
{
  "emailEnabled": false,
  "telegramEnabled": true,
  "whatsappEnabled": false,
  "preferences": {
    "connectionUpdated": true,
    "shipmentAssigned": true,
    "payoutUpdates": true,
    "codDepositUpdates": true
  }
}
```

**Behaviour**:
- Setting one of `emailEnabled` / `telegramEnabled` / `whatsappEnabled` to `true` **auto-disables
  the other two**. To turn off all secondary channels, send the relevant flag(s) as `false`.
- Enabling a channel that is **not verified** is rejected with
  `400 DELIVERY_AGENCY_NOTIFICATION_CHANNEL_NOT_VERIFIED`.
- `preferences` fields not included are left unchanged.

**Success Response** — `200 OK`: same shape as `GET`, plus `"message": "Preferences updated successfully"`.

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body
- `400` – `DELIVERY_AGENCY_NOTIFICATION_CHANNEL_NOT_VERIFIED` – Tried to enable a channel that
  isn't verified. `details.channel` is `email` \| `telegram` \| `whatsapp`.

---

<a name="list"></a>
### GET /api/agency/notifications

**Description**: List notifications (newest first), paginated.

**Query Parameters**:
- `page` (integer, optional, default `1`)
- `limit` (integer, optional, default `20`, max `50`)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "66f0a3...",
      "type": "connection.request_received",
      "title": "New connection request",
      "message": "Acme Vendor wants to connect with you as their delivery partner.",
      "aggregateType": "connection",
      "aggregateId": "66f0a1...",
      "action": {
        "label": "View connection",
        "path": "vendor-connections/66f0a1...",
        "url": "https://agency.example.com/vendor-connections/66f0a1..."
      },
      "isRead": false,
      "deliveredVia": ["in-app", "push"],
      "createdAt": "2026-07-14T10:00:00.000Z"
    }
  ],
  "unreadCount": 1,
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

`action` is localized in the agency's language, same rules as vendor notifications — see
[Vendor Notifications — the action object](../vendor/notifications.md#get-apivendornotifications).
It is `null` only when no deep-link base URL (`AGENCY_APP_URL`) is configured server-side.

**Error Responses**: `400` – `VALIDATION_ERROR` – Invalid query parameters.

---

<a name="mark-read"></a>
### PATCH /api/agency/notifications/:id/read

**Description**: Mark a single notification as read. Idempotent.

**Success Response** — `200 OK`: the updated notification (including `action`, `deliveredVia`) +
`"message": "Notification marked as read"`.

**Error Responses**:
- `404` – `DELIVERY_AGENCY_NOTIFICATION_NOT_FOUND`
- `400` – `VALIDATION_ERROR` – Invalid notification ID format.

---

<a name="mark-all-read"></a>
### POST /api/agency/notifications/read-all

**Description**: Mark all of the agency's notifications as read.

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "count": 3 }, "message": "Marked 3 notification(s) as read" }
```

---

<a name="register-device"></a>
### POST /api/agency/devices

**Description**: Register (or refresh) the current device's FCM token so it receives push. Same
endpoint shape as the vendor one — see
[Vendor Notifications — Push notifications (FCM)](../vendor/notifications.md#push-notifications-fcm)
for the full client-side integration guide; everything there applies unchanged, just against
`/api/agency/devices` with an agency Bearer token.

**Request Body**:
```json
{ "token": "fcm-registration-token", "platform": "web", "userAgent": "optional" }
```

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "id": "string", "platform": "web", "lastUsedAt": "2026-07-14T10:00:00.000Z" }, "message": "Device registered for push notifications" }
```

---

<a name="unregister-device"></a>
### DELETE /api/agency/devices

**Description**: Unregister a push token (call on logout).

**Request Body**: `{ "token": "fcm-registration-token" }`

**Success Response** — `200 OK`: `{ "success": true, "message": "Device unregistered from push notifications" }`

---

## Notification language

Notifications are sent in the agency's preferred language — lives on the agency profile, not the
notification-preferences payload.

- **Field**: `preferredLanguage` (read) / `preferred_language` (write)
- **Allowed values**: `en`, `fr`, `pt`, `es`, `ar` (default `en`)
- **Read**: `GET /api/agency/profile` → `data.preferredLanguage`
- **Write**: `PATCH /api/agency/profile` → `{ "preferred_language": "fr" }`

---

## Reference

### Events

| Preference key | Notification `type` | `aggregateType` | Fires when |
|---|---|---|---|
| `connectionUpdated` | `connection.request_received`, `connection.approved`, `connection.rejected`, `connection.reapproval_needed` | `connection` | A vendor connection request/approval/rejection/reapproval-needed happens — the agency-side mirror of the vendor's `connectionUpdated`. See [Vendor connections](./vendor-connections.md). |
| `shipmentAssigned` | `shipment.assigned` | `shipment` | A vendor dispatches an order to this agency (manual dispatch or auto-redirect on payment) — the shipment moves `pending` → `assigned` and appears on `GET /api/agency/shipments`. `aggregateId` is the `Shipment` id; `action.path` deep-links to `shipments/{shipmentId}`. See [Shipments](./shipments.md). |
| `payoutUpdates` | `payout.requested`, `payout.paid`, `payout.rejected` | `payout` | Your own payout request is created, paid, or rejected. `aggregateId` is the `PayoutRequest` id; `action.path` deep-links to `tickets/{ticketId}`. See [Earnings — Requesting a payout](./earnings.md#requesting-a-payout). |
| `codDepositUpdates` | `cod.deposit.declared`, `cod.deposit.direct_to_platform` | `deposit` | An agent declares a hand-over you must confirm/reject, or pays the platform directly. `action.path` deep-links to `cod/deposits/{depositId}`. See [COD cash management](./cod-cash-management.md). |
| `planUpdates` | `plan.expiring`, `plan.expired`, `shipment.cap.exceeded` | `plan` | **Billing.** Your subscription plan is nearing expiry / has expired (handed over to a queued plan or downgraded to free), or you crossed your plan's unterminated-shipment **soft** cap. `aggregateId` is the agency id; `action.path` deep-links to `plans`. See [Agency Billing](./billing.md). The shipment-cap alert is monitoring-only — deliveries are never blocked. |
| `storageAlert` | `storage.alert` | `storage` | **Media storage** crossed 80 / 90 / 100% of your plan cap (highest crossed band only, at most once per month per band). `aggregateId` is the agency id; `action.path` deep-links to `settings/storage`. See [Storage](./storage.md). Agent delivery proofs count toward this. |

Note the direction: these fire when the **vendor** is the actor on a connection the agency cares
about (vendor sent a request, approved/rejected/reapproved one). The symmetric vendor-side events
(fired when the **agency** is the actor) are documented in
[Vendor Notifications — Events](../vendor/notifications.md#events).

### Delivery channels

Same rules as vendor — see
[Vendor Notifications — Delivery channels](../vendor/notifications.md#delivery-channels).
`push` is an always-on companion to `in-app`, not the secondary channel.

### Verifying a channel

The `*Verified` flags reflect account state (email verification, Telegram link, WhatsApp link) —
same linking flows as vendor. See
[Linking Notification Channels](../vendor/notification-channels.md) (role-agnostic; use the agency
Bearer token and `/api/agency/...` paths where the vendor doc says `/api/vendor/...`).

### Other behaviour

- Notification IDs are 24-char hex (MongoDB ObjectId); invalid formats return `VALIDATION_ERROR`.
- Marking as read sets `isRead: true` and `readAt`; repeating it is idempotent.
- `unreadCount` reflects only unread notifications; list `limit` max is `50`.
- Notifications are immutable except for `isRead`. They cannot be deleted.

### Error envelope

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable description" } }
```
