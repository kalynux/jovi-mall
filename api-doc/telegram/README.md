# Telegram Account Linking & Notifications

Any authenticated user (**any role**) can link their Telegram account to receive platform
notifications there, toggle them on/off, and disconnect. Admins can also send a Telegram message
directly. Linking uses a **deep-link + single-use token** handshake completed inside the Telegram app.

- **Base path**: `/api/webhooks/telegram` — the user-facing endpoints share this prefix with the bot
  webhook (`POST /webhook`, called by the bot bridge). Only `/webhook` is public; everything else
  requires auth.
- **Auth**: cookie or `Bearer`. The user is resolved from the **User id** (`req.auth.user.id`), so
  these are **role-agnostic** — a customer, vendor, agency, agent or admin can all link.
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhooks/telegram/link-token` | any authenticated | Generate a Telegram deep-link + token |
| `GET` | `/webhooks/telegram/status` | any authenticated | Check the caller's Telegram link status |
| `POST` | `/webhooks/telegram/toggle` | any authenticated | Toggle notifications on/off |
| `POST` | `/webhooks/telegram/disconnect` | any authenticated | Unlink the Telegram account |
| `POST` | `/webhooks/telegram/send` | **admin** | Send a Telegram message to a user/chat |
| `POST` | `/webhooks/telegram/webhook` | public (bot bridge) | Inbound bot messages — **not** a frontend endpoint |

### Linking flow (frontend)

```
1. POST /api/webhooks/telegram/link-token         → { bot_url, expires_at }
2. Open `bot_url` (https://t.me/<bot>?start=<token>) — the user taps "Start" in Telegram.
   The bot consumes the single-use token and links the account server-side; the user
   gets a "successfully linked" message in Telegram.
3. GET  /api/webhooks/telegram/status             → { linked: true, ... } to confirm & render state.
```

---

## POST `/webhooks/telegram/link-token`

**Purpose**: Generate a single-use link token and a Telegram deep-link URL for the caller.

**Auth**: any authenticated user

### Example success `200`

```json
{
  "success": true,
  "data": {
    "bot_url": "https://t.me/YourBotName?start=8f3c1a2b...",
    "expires_at": "2026-07-17T10:40:00.000Z"
  }
}
```

> Open `bot_url` in Telegram (or render it as a QR / button). The embedded token is single-use and
> expires at `expires_at`.

---

## GET `/webhooks/telegram/status`

**Purpose**: Return the caller's Telegram link status.

**Auth**: any authenticated user

### Example success `200` (linked)

```json
{
  "success": true,
  "data": {
    "linked": true,
    "chatId": "123456789",
    "telegramUserId": 123456789,
    "firstName": "Jane",
    "lastName": "Doe",
    "username": "janedoe",
    "isActive": true,
    "connectedAt": "2026-07-10T08:00:00.000Z"
  }
}
```

### Example success `200` (not linked)

```json
{ "success": true, "data": { "linked": false } }
```

---

## POST `/webhooks/telegram/toggle`

**Purpose**: Toggle whether the caller receives Telegram notifications (does not unlink).

**Auth**: any authenticated user

### Example success `200`

```json
{ "success": true, "data": { "is_active": false } }
```

### Errors

| Status | `error.code` | When |
|---|---|---|
| 404 | `TELEGRAM_NOT_LINKED` | The caller has no linked Telegram account |

---

## POST `/webhooks/telegram/disconnect`

**Purpose**: Unlink the caller's Telegram account. Sends a warning message to the chat, then deletes the link.

**Auth**: any authenticated user

### Example success `200`

```json
{ "success": true, "data": null, "message": "Account disconnected" }
```

### Errors

| Status | `error.code` | When |
|---|---|---|
| 404 | `TELEGRAM_NOT_LINKED` | Nothing to disconnect |

---

## POST `/webhooks/telegram/send` (admin)

**Purpose**: Send a Telegram message directly to a user (by `userId`) or a chat (by `chatId`).

**Auth**: `admin` only

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `userId` | string | conditionally | Provide **either** `userId` **or** `chatId` |
| `chatId` | string | conditionally | " |
| `message` | string | ✅ | 1–4096 chars |

> Validation: at least one of `userId` / `chatId` must be present, else `400 VALIDATION_ERROR`
> ("Either userId or chatId must be provided").

### Example request

```json
{ "userId": "664usr...", "message": "Your payout has been processed." }
```

### Example success `200`

```json
{ "success": true, "data": { "success": true, "messageId": 42 } }
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing `message`, or neither `userId` nor `chatId` |
| `AUTH_MISSING_TOKEN` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | `/send` called by a non-admin |
| `TELEGRAM_NOT_LINKED` | 404 | Toggle/disconnect with no linked account |
| `TELEGRAM_LINK_FAILED` | 500 | Token generation failed |
| `INTERNAL_SERVER_ERROR` | 500 | Send/status failure |

## Notes
- `POST /webhooks/telegram/webhook` is the **bot bridge** endpoint (inbound `/start <token>` etc.), not
  a frontend endpoint — do not call it from the app.
- Requires `TELEGRAM_BOT_NAME` configured server-side for the deep-link URL.

## Related
- [../whatsapp/README.md](../whatsapp/README.md) — the equivalent WhatsApp linking
- [../notifications/whatsapp-templates.md](../notifications/whatsapp-templates.md)
- Per-role notification preferences: `vendor/notifications.md`, `agency/notifications.md`, `agent/notifications.md`
