# Vendor Notifications

## Base Path

```
/api/vendor
```

## Authentication

**Authorization**: Vendor access required. All requests must include a valid Bearer token with the vendor role:

```
Authorization: Bearer <access_token>
```

---

## Notification Settings (build the settings UI from this)

A vendor's notification settings — the values the backend reads when deciding **whether**, **where**, and **in what language** to notify a vendor — are made up of three parts:

1. **Event subscriptions** (`preferences.*`) — per-event on/off. Read/written via the **notification-preferences** endpoints below.
2. **Delivery channel** (`*Enabled` + `*Verified`) — which secondary channel receives messages. Read/written via the **notification-preferences** endpoints below.
3. **Language** (`preferred_language`) — the language every notification is rendered in. Lives on the **vendor profile** (see [Notification language](#notification-language)).

### How delivery is decided (so the UI matches backend behaviour)

- **In-app is always on** and cannot be disabled. Every notification is stored and returned by `GET /notifications` regardless of channel settings.
- **At most ONE secondary channel** is active at a time (email **or** telegram **or** whatsapp). Enabling one **auto-disables** the others.
- A secondary channel only delivers if it is **both enabled AND verified**. The platform picks the first available secondary channel in priority order **telegram → email → whatsapp**.
- An event only notifies if its toggle in `preferences` is `true`.
- The message is rendered in the vendor's `preferred_language`.

> UI implication: present the three channels as a **single choice** (radio group: In-app only / Telegram / Email / WhatsApp), and **disable a channel option until it is verified** (`*Verified: true`). Attempting to enable an unverified channel is rejected by the API (see below).

---

## Endpoints

### GET /api/vendor/notification-preferences

**Description**: Retrieve the vendor's notification settings: channel enablement, live verification status, and per-event subscriptions.

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
      "orderCreated": true,
      "orderCancelled": true,
      "bookingCreated": true,
      "bookingCancelled": true,
      "paymentReceivedPartial": true,
      "paymentReceivedFull": true,
      "storageAlert": true,
      "connectionUpdated": true,
      "payoutUpdates": true,
      "shipmentRejected": true,
      "planUpdates": true
    }
  }
}
```

**Field reference**:

| Field | Type | Writable | Meaning |
|---|---|---|---|
| `inAppEnabled` | boolean | No (always `true`) | In-app notifications; cannot be turned off |
| `emailEnabled` | boolean | Yes | Email is the active secondary channel |
| `telegramEnabled` | boolean | Yes | Telegram is the active secondary channel |
| `whatsappEnabled` | boolean | Yes | WhatsApp is the active secondary channel |
| `emailVerified` | boolean | **No (read-only, live)** | Vendor's email is verified |
| `telegramVerified` | boolean | **No (read-only, live)** | Vendor has an active Telegram link |
| `whatsappVerified` | boolean | **No (read-only, live)** | Vendor has a verified WhatsApp number |
| `preferences.*` | boolean | Yes | Per-event subscription (see [Events](#events)) |

The `*Verified` flags are **computed live** from the vendor's account (email verification, Telegram link, WhatsApp link) — they are not stored toggles and are ignored on write. Use them to enable/disable channel options in the UI.

---

### PATCH /api/vendor/notification-preferences

**Description**: Update notification settings. All fields optional; send only what changes.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body** (all optional):
```json
{
  "emailEnabled": false,
  "telegramEnabled": true,
  "whatsappEnabled": false,
  "preferences": {
    "orderCreated": true,
    "orderCancelled": true,
    "bookingCreated": false,
    "bookingCancelled": false,
    "paymentReceivedPartial": true,
    "paymentReceivedFull": true,
    "storageAlert": true,
    "connectionUpdated": true,
    "payoutUpdates": true,
    "shipmentRejected": true,
    "planUpdates": true
  }
}
```

**Behaviour**:
- Setting one of `emailEnabled` / `telegramEnabled` / `whatsappEnabled` to `true` **auto-disables the other two** (single secondary channel). To turn off all secondary channels, send the relevant flag(s) as `false`.
- Enabling a channel that is **not verified** is **rejected** with `400 VENDOR_NOTIFICATION_CHANNEL_NOT_VERIFIED` — the vendor must verify/link that channel first.
- `preferences` fields not included are left unchanged.

**Success Response** — `200 OK`: same shape as `GET`, plus `"message": "Preferences updated successfully"`.

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid request body
- `400` – `VENDOR_NOTIFICATION_CHANNEL_NOT_VERIFIED` – Tried to enable a channel that isn't verified. `details.channel` is `email` \| `telegram` \| `whatsapp`.

---

### GET /api/vendor/notifications

**Description**: List notifications (newest first), with optional filtering and pagination.

**Query Parameters**:
- `isRead` (string, optional) — `true` or `false`
- `page` (integer, optional, default `1`)
- `limit` (integer, optional, default `20`, max `50`)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "type": "order.created",
      "title": "New order received",
      "message": "You received a new order #ORD-12345 for XAF 25,000.",
      "aggregateType": "order",
      "aggregateId": "665f0c2a…",
      "action": {
        "label": "View order",
        "path": "orders/665f0c2a…",
        "url": "https://dashboard.example.com/orders/665f0c2a…"
      },
      "isRead": false,
      "deliveredVia": ["in-app", "push", "telegram"],
      "createdAt": "2026-06-26T23:54:00.000Z"
    }
  ],
  "unreadCount": 5,
  "meta": { "total": 50, "page": 1, "limit": 20, "pages": 3 }
}
```

**The `action` object (notification click target).** Use it to make each notification clickable — e.g. clicking a "new order" notification opens that order's detail page. It is **localized** in the vendor's language and is the same action surfaced as a button on the secondary channels.

| Field | Type | Meaning |
|---|---|---|
| `action.label` | string | Localized button text, e.g. `"View order"` |
| `action.path` | string | **Relative** deep-link for your SPA router, e.g. `"orders/665f0c2a…"`. Prefer this for in-app navigation. |
| `action.url` | string \| absent | **Absolute** deep-link. Present only when the backend has `VENDOR_APP_URL` configured. |

`action` is `null` only for the rare case a notification type has no associated screen. `aggregateType` + `aggregateId` are also returned if you prefer to build routes yourself (see [Aggregate references](#aggregate-references-deeplinks)) — but `action.path` already encodes the correct destination for each type.

**Error Responses**: `400` – `VALIDATION_ERROR` – Invalid query parameters.

---

### PATCH /api/vendor/notifications/:id/read

**Description**: Mark a single notification as read. Idempotent.

**Path Parameters**: `id` (24-char hex ObjectId, required)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "type": "order.created",
    "title": "New order received",
    "message": "You received a new order #ORD-12345 for XAF 25,000.",
    "aggregateType": "order",
    "aggregateId": "string",
    "action": { "label": "View order", "path": "orders/665f0c2a…", "url": "https://dashboard.example.com/orders/665f0c2a…" },
    "deliveredVia": ["in-app", "telegram"],
    "isRead": true,
    "readAt": "2026-06-26T23:55:00.000Z",
    "createdAt": "2026-06-26T23:54:00.000Z"
  },
  "message": "Notification marked as read"
}
```

**Error Responses**:
- `404` – `VENDOR_NOTIFICATION_NOT_FOUND` – Not found or not owned by the vendor
- `400` – `VALIDATION_ERROR` – Invalid notification ID format

---

### POST /api/vendor/notifications/read-all

**Description**: Mark all of the vendor's notifications as read (bulk).

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": { "count": 12 },
  "message": "Marked 12 notification(s) as read"
}
```

---

### POST /api/vendor/devices

**Description**: Register (or refresh) the current browser/device's FCM token so it receives push notifications. Call this after the user grants notification permission and you obtain an FCM token. Calling it again with the same token is safe (idempotent upsert) — do so whenever the token is refreshed.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body**:
```json
{
  "token": "fcm-registration-token-from-getToken()",
  "platform": "web",
  "userAgent": "Mozilla/5.0 ... (optional)"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | Yes | The FCM registration token from the Firebase Web SDK `getToken()` |
| `platform` | string | Yes | One of `web` \| `android` \| `ios`. Use `web` for the dashboard. |
| `userAgent` | string | No | Optional free-text, for your own device-management UX |

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": { "id": "string", "platform": "web", "lastUsedAt": "2026-06-27T10:00:00.000Z" },
  "message": "Device registered for push notifications"
}
```

**Error Responses**: `400` – `VALIDATION_ERROR` – Invalid body (missing token / bad platform).

---

### DELETE /api/vendor/devices

**Description**: Unregister an FCM token so the device stops receiving push. **Call this on logout** (and before clearing the FCM token client-side). Idempotent — unknown tokens return success.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body**:
```json
{ "token": "fcm-registration-token" }
```

**Success Response** — `200 OK`:
```json
{ "success": true, "message": "Device unregistered from push notifications" }
```

> Self-healing: the backend automatically removes tokens that FCM reports as expired/invalid during a send, so stale tokens are pruned even if the client never calls DELETE. You should still call DELETE on logout to stop pushing to a device the user signed out of.

---

## Notification language

Notifications are sent in the vendor's preferred language. This is **not** part of the notification-preferences payload — it lives on the vendor profile.

- **Field**: `preferredLanguage` (read) / `preferred_language` (write)
- **Allowed values**: `en`, `fr`, `pt`, `es`, `ar` (default `en`)
- **Read**: `GET /api/vendor/profile` → `data.preferredLanguage`
- **Write**: `PATCH /api/vendor/profile` → `{ "preferred_language": "fr" }`
- Invalid values are rejected with `400 VALIDATION_ERROR`.

The settings UI should include a language selector wired to the vendor profile endpoint.

---

## Push notifications (FCM)

Real-time notifications are delivered to the vendor dashboard via **Firebase Cloud Messaging (FCM) web push**. The moment a notification-worthy event occurs (new order, payment, etc.), the backend pushes it to every device the vendor has registered — no polling required. Push works even when the dashboard tab is in the background or closed (via a service worker).

### Mental model (read this first)

- **In-app is the source of truth.** Every notification is persisted and returned by `GET /notifications` **regardless of push outcome**.
- **Push is a best-effort companion**, not a replacement. A push can fail to arrive (permission denied, device offline, no token yet, transient FCM error). Those notifications are **not lost** — they are still in `GET /notifications`.
- Therefore the frontend needs **two paths**, and both are required:
  1. **On load / on reconnect** → call `GET /notifications` to render history + unread badge (this is your fallback for any push that didn't arrive).
  2. **While the app is open / in the background** → receive live pushes via FCM and prepend them to the list / bump the unread badge.

### What the dashboard frontend dev must implement

This is a **client-side Firebase Web SDK** integration. The backend only needs the FCM **token** (registered via `POST /api/vendor/devices`). Steps:

**1. Get the FCM Web project config.** Ask the backend/dev-ops team for the **messaging** Firebase project's web config and the **VAPID public key** (Web Push certificate). Note this is a *separate* Firebase project from file storage — use the credentials given for messaging.

```js
// firebase config (from the messaging Firebase project → Project settings → General → Web app)
const firebaseConfig = {
  apiKey: "…",
  authDomain: "<project>.firebaseapp.com",
  projectId: "<messaging-project-id>",
  messagingSenderId: "…",
  appId: "…",
};
const VAPID_KEY = "<Web Push certificate key pair — public key>";
```

**2. Add a service worker** at the site root: `public/firebase-messaging-sw.js`. It must be served from the origin root (`/firebase-messaging-sw.js`) so FCM can use it for background messages.

```js
// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({ /* same firebaseConfig as above */ });
const messaging = firebase.messaging();

// Background messages (tab not focused / closed). Renders the OS notification.
messaging.onBackgroundMessage(({ notification, data }) => {
  self.registration.showNotification(notification.title, {
    body: notification.body,
    data, // contains type, aggregateType, aggregateId, url
  });
});

// Deep-link when the user clicks the OS notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
```

**3. Request permission + register the token** (after the vendor logs in):

```js
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const token = await getToken(messaging, { vapidKey: VAPID_KEY });
  if (!token) return;

  // Send the token to the backend so this device starts receiving push.
  await fetch('/api/vendor/devices', {
    method: 'POST',
    credentials: 'include', // cookie auth; or send Authorization: Bearer
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, platform: 'web', userAgent: navigator.userAgent }),
  });
}
```

**4. Handle foreground messages** (tab focused — `onBackgroundMessage` does *not* fire here, so render your own in-app toast and update the list/badge):

```js
onMessage(messaging, ({ notification, data }) => {
  // e.g. show a toast and prepend to the in-app notification list
  showToast(notification.title, notification.body);
  prependNotification({
    type: data.type,
    aggregateType: data.aggregateType,
    aggregateId: data.aggregateId,
    title: notification.title,
    message: notification.body,
  });
  incrementUnreadBadge();
});
```

**5. On logout**, unregister so the signed-out device stops receiving push:

```js
import { getToken, deleteToken } from 'firebase/messaging';
const token = await getToken(messaging, { vapidKey: VAPID_KEY });
await fetch('/api/vendor/devices', {
  method: 'DELETE',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});
await deleteToken(messaging);
```

### Push message payload

Every push carries a `notification` block (for display) and a `data` block (for routing/deep-linking). All `data` values are **strings**.

| Block | Field | Example | Use |
|---|---|---|---|
| `notification` | `title` | `"New order received"` | Toast/OS title (already localized in the vendor's language) |
| `notification` | `body` | `"You received a new order #ORD-12345 for XAF 25,000."` | Toast/OS body |
| `data` | `type` | `"order.created"` | The notification `type` (see [Events](#events)) |
| `data` | `aggregateType` | `"order"` | Entity kind for deep-linking |
| `data` | `aggregateId` | `"665f…"` | Entity id for deep-linking |
| `data` | `path` | `"orders/665f…"` | **Relative** deep-link for the SPA router — same value as `action.path` |
| `data` | `url` | `"https://dashboard…/orders/665f…"` | Absolute deep-link (present when `VENDOR_APP_URL` is configured server-side) |

> The push `data.path`/`data.url` mirror the in-app notification's `action`, so clicking an OS notification and clicking the in-app item navigate to the same place. In the service worker's `notificationclick` handler, prefer `data.url` (you need an absolute URL there); inside the app (foreground `onMessage` / in-app list) prefer `data.path` / `action.path` for client-side routing.

The push title/body are the **same** localized copy as the corresponding in-app notification, so foreground toasts and the in-app list stay consistent.

### Reconciliation pattern (so missed pushes always show)

```
on app load / tab regains focus / socket-or-network reconnect:
  GET /api/vendor/notifications?page=1&limit=20   → render list + unreadCount

while app open:
  onMessage (foreground)        → toast + prepend + bump badge
  onBackgroundMessage (SW)      → OS notification; on click, deep-link via data.url

on click of an in-app item:     PATCH /notifications/:id/read
```

Because `GET /notifications` returns everything regardless of push success, a vendor who had no device registered, denied permission, or was offline still sees all their notifications on next load. **Do not** rely on push alone for correctness — always hydrate from `GET /notifications`.

### Notes & gotchas

- **No backend change is required to "serve missed pushes"** — `GET /notifications` already does this. Push is purely additive.
- `getToken()` requires the service worker to be registered and `Notification.requestPermission()` to be granted; on insecure origins (non-HTTPS, except `localhost`) it will fail.
- Re-`POST /api/vendor/devices` whenever the SDK rotates the token (listen for token refresh) — the backend upserts, so duplicates are not created.
- If the vendor uses multiple browsers/devices, each registers its own token and all receive push.

---

## Reference

### Events

The subscribable events (`preferences.*` key → notification `type`):

| Preference key | Notification `type` | `aggregateType` | Fires when |
|---|---|---|---|
| `orderCreated` | `order.created` | `order` | A new order is received |
| `orderCancelled` | `order.cancelled` | `order` | An order is cancelled |
| `bookingCreated` | `booking.created` | `booking` | A new service booking is received |
| `bookingCancelled` | `booking.cancelled` | `booking` | A service booking is cancelled |
| `paymentReceivedPartial` | `payment.received.partial` | `payment` | A partial payment is received |
| `paymentReceivedFull` | `payment.received.full` | `payment` | A full payment is received |
| `storageAlert` | `storage.alert` | `storage` | Media storage crosses a threshold (80% / 90% / 100%). `aggregateId` is the vendor id. See [Storage](./storage.md). |
| `connectionUpdated` | `connection.request_received`, `connection.approved`, `connection.rejected`, `connection.reapproval_needed` | `connection` | An agency connection request/approval/rejection/reapproval-needed happens where the **agency** was the actor. See [Agency connections](./agency-connections.md). The symmetric agency-side events (fired when the **vendor** is the actor) are documented in [Agency Notifications — Events](../agency/notifications.md#events). |
| `payoutUpdates` | `payout.requested`, `payout.paid`, `payout.rejected` | `payout` | Your own payout request is created, paid, or rejected. `aggregateId` is the `PayoutRequest` id; `action.path` deep-links to `tickets/{ticketId}` — the request is tracked as a ticket, see [Earnings — Requesting a payout](./earnings.md#requesting-a-payout). |
| `shipmentRejected` | `shipment.rejected` | `order` | A delivery agency declined a shipment; its items move to `pending_agency_reassignment` and you must route them to another agency. `aggregateId` is the order id; `action.path` deep-links to `orders/{orderId}`. The specific reason + note are shown on the order's per-item delivery detail (see [Orders](./orders.md)), not in the notification text. |
| `planUpdates` | `plan.expiring`, `plan.expired` | `plan` | **Billing.** Your subscription plan is nearing expiry, or has expired (handed over to a queued plan, or downgraded to the free `starter` tier). `aggregateId` is the vendor id; `action.path` deep-links to `plans`. See [Billing](./billing.md). |

### Delivery channels

| Channel value (`deliveredVia`) | Configurable | Requires verification |
|---|---|---|
| `in-app` | No (always present) | No |
| `push` | No (auto, when devices are registered) | No |
| `telegram` | Yes | Yes (active Telegram link) |
| `email` | Yes | Yes (verified email) |
| `whatsapp` | Yes | Yes (verified WhatsApp number) |

Priority when choosing the **secondary** channel: **telegram → email → whatsapp**. Only one secondary channel is ever used per notification, and it must be enabled **and** verified. On every channel the message includes a localized action button (e.g. "View order") deep-linking into the dashboard.

`push` is **not** a secondary channel and does **not** compete with the single-secondary-channel rule. It is an always-on **companion** to `in-app`: whenever the vendor has one or more registered devices (see [Push notifications (FCM)](#push-notifications-fcm)), every in-app notification is also pushed to those devices. `deliveredVia` includes `"push"` only when at least one device was targeted.

### Verifying a channel

The `*Verified` flags reflect account state, set by the relevant linking/verification flow (email verification, Telegram account linking, WhatsApp number linking). The notification-preferences endpoints do **not** verify channels — direct the vendor to the corresponding flow, then re-read preferences to see the updated `*Verified` value.

**Full linking flows and endpoints:** see [Linking Notification Channels](./notification-channels.md).

### Aggregate references (deeplinks)

Each notification carries `aggregateType` + `aggregateId` for frontend deeplinks: `order` / `booking` / `payment` → the respective entity; `storage` → the storage/usage screen with `aggregateId` = vendor id.

### Other behaviour

- Notification IDs are 24-char hex (MongoDB ObjectId); invalid formats return `VALIDATION_ERROR`.
- Marking as read sets `isRead: true` and `readAt`; repeating it is idempotent.
- `unreadCount` reflects only unread notifications; list `limit` max is `50`.
- Notifications are immutable except for `isRead`. They cannot be deleted.

### Error envelope

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable description" } }
```
