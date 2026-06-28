# Linking Notification Channels (Email / Telegram / WhatsApp)

To receive notifications on a secondary channel, a vendor completes **two independent steps**:

1. **Verify / link the channel** (the flows on this page) → flips the read-only `*Verified` flag to `true`.
2. **Enable the channel** in notification settings (`PATCH /api/vendor/notification-preferences`, see [notifications.md](./notifications.md)) → only **one** secondary channel can be active at a time.

Both are required: the backend only delivers on a channel that is **verified AND enabled**. In-app notifications always work and need neither step.

> The settings UI should read `emailVerified` / `telegramVerified` / `whatsappVerified` from `GET /api/vendor/notification-preferences` to decide whether to show "Connect" (start a flow below) or "Enable" (toggle the channel).

All authenticated endpoints below require `Authorization: Bearer <vendor token>`.

---

## Email

Sets `emailVerified: true` (backed by the vendor's `email_verified`).

### Step 1 — Request the verification email
`POST /api/auth/send-email-verification`

- No body. Uses the authenticated vendor's email.
- Sends an email containing a one-time verification link (token valid ~ configured TTL).

**Success** — `200 OK`:
```json
{ "message": "Verification email sent" }
```
**Errors**:
- `404 AUTH_PROFILE_NOT_FOUND` — no profile for the role
- `409 AUTH_EMAIL_ALREADY_VERIFIED` — already verified
- `422 AUTH_EMAIL_MISSING` — vendor has no email on file

### Step 2 — Vendor clicks the emailed link
`GET /api/auth/verify-email?token=<token>`

- Public endpoint; the link is opened from the vendor's inbox (frontend does not build it).
- Marks the email verified.

**Success** — `200 OK`:
```json
{ "message": "Email verified successfully" }
```
**Errors**:
- `400 AUTH_VERIFY_TOKEN_INVALID` — missing, invalid, or expired token

After this, `emailVerified` becomes `true` and the vendor can set `emailEnabled: true`.

---

## Telegram

Sets `telegramVerified: true` (backed by an **active** Telegram link).

### Step 1 — Get the bot deep-link
`POST /api/webhooks/telegram/link-token`

**Success** — `200 OK`:
```json
{
  "bot_url": "https://t.me/<BotName>?start=<token>",
  "expires_at": "2026-06-26T12:10:00.000Z"
}
```
- Token is single-use, valid 10 minutes. Show `bot_url` as a button/QR for the vendor to open in Telegram.

### Step 2 — Vendor taps "Start" in Telegram
The vendor opens `bot_url` and presses Start; Telegram sends `/start <token>` to the bot, which the backend consumes to create the link and replies with a confirmation message. No frontend call needed.

### Status / manage
- `GET /api/webhooks/telegram/status` →
  ```json
  { "linked": true, "isActive": true, "chatId": "...", "firstName": "...", "connectedAt": "..." }
  ```
- `POST /api/webhooks/telegram/toggle` → flips `isActive` (`{ "is_active": false }`). **Note:** when `isActive` is `false`, `telegramVerified` reports `false` and Telegram delivery stops, even if previously linked.
- `POST /api/webhooks/telegram/disconnect` → removes the link.

After linking (and `isActive: true`), `telegramVerified` becomes `true`; the vendor can set `telegramEnabled: true`.

---

## WhatsApp

Sets `whatsappVerified: true` (backed by the vendor's verified `wa` binding).

### Step 1 — Request a WhatsApp verification code
`POST /api/auth/request-wa-verification`

- Optional body: `{ "update_other_roles": true }` — also verify the same person's other roles (vendor/customer/agency/agent) in one go.

**Success** — `200 OK`:
```json
{
  "code": "A1B2C3D4E5F6G7H8",
  "command": "/link:A1B2C3D4E5F6G7H8",
  "bot_number": "<WA_BOT_NUMBER>",
  "wa_link": "https://wa.me/<WA_BOT_NUMBER>?text=%2Flink%3AA1B2C3D4E5F6G7H8",
  "expires_in_seconds": 600,
  "instructions": "Click the link to verify your WhatsApp account automatically, or send the command manually to our WhatsApp bot."
}
```
**Errors**:
- `404 AUTH_PROFILE_NOT_FOUND`
- `409 AUTH_WA_ALREADY_VERIFIED`

### Step 2 — Vendor sends the command to the bot
The vendor taps `wa_link` (opens WhatsApp pre-filled with `/link:CODE`) and sends it — or sends `/link:CODE` manually to `bot_number`. The backend matches the code, binds the sender's WhatsApp number, and marks it verified. No frontend call needed.

### Status / manage
- `GET /api/webhooks/whatsapp/link/status` →
  ```json
  { "linked": true, "wa_phone_id": "...", "name": "...", "bound_at": "..." }
  ```
- `DELETE /api/webhooks/whatsapp/link` → unlinks the WhatsApp account.

After linking, `whatsappVerified` becomes `true`; the vendor can set `whatsappEnabled: true`.

---

## Putting it together (suggested UI flow)

For each channel card in the notification settings screen:

1. Read `*Verified` from `GET /api/vendor/notification-preferences`.
2. If **not verified** → show **Connect**, which starts the relevant Step 1 above (email: send link; telegram: open `bot_url`; whatsapp: open `wa_link`). Poll/refresh preferences to detect when `*Verified` turns `true`.
3. If **verified** → show an **Enable** toggle that calls `PATCH /api/vendor/notification-preferences`. Remember enabling one secondary channel auto-disables the others (single-channel rule, priority telegram → email → whatsapp).
4. Language is set separately on the profile (`preferred_language`) — see [notifications.md](./notifications.md#notification-language).
