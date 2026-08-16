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

## Telegram & WhatsApp — one flow, not two

Both channels now connect through the **same** mechanism, fully documented in
[../connections/README.md](../connections/README.md). The short version:

1. `GET /api/me/connections` → for each unconnected channel, `howToConnect` names the bot and
   the command (`/connect`) and gives a `deepLink` to open the chat.
2. The vendor sends `/connect` to the bot. The **bot** replies with a 6-character code.
3. `POST /api/me/connections` with `{ "code": "A7K9P2" }` → connected.

`telegramVerified` / `whatsappVerified` in the preferences payload flip to `true` once a
connection exists, and the vendor can then set `telegramEnabled` / `whatsappEnabled`.

To disconnect: `DELETE /api/me/connections/telegram` or `.../whatsapp`.

> The code is case-insensitive; `O`→`0` and `I`/`L`→`1`; spaces and hyphens are ignored. Send
> exactly what the vendor typed.

> **`/api/me/connections` is role-agnostic** — it binds to the user account, not the vendor
> profile. A person who is both a vendor and a customer connects once.

### What changed

| Gone | Replacement |
|---|---|
| `POST /api/auth/request-wa-verification` | `POST /api/me/connections` |
| `GET /api/webhooks/whatsapp/link/status` | `GET /api/me/connections` |
| `DELETE /api/webhooks/whatsapp/link` | `DELETE /api/me/connections/whatsapp` |
| `POST /api/webhooks/telegram/link-token` | `GET /api/me/connections` |
| `GET /api/webhooks/telegram/status` | `GET /api/me/connections` |
| `POST /api/webhooks/telegram/toggle` | nothing — use `telegramEnabled` |
| `POST /api/webhooks/telegram/disconnect` | `DELETE /api/me/connections/telegram` |

⚠️ **The Telegram `toggle` endpoint is gone and this is a behaviour change worth reading.** It
muted delivery *and* made `telegramVerified` report `false`, so a connected vendor's settings
screen offered them "Connect" again as though they had never linked. `telegramVerified` now
means only "a Telegram connection exists"; `telegramEnabled` is the single mute, exactly as
WhatsApp has always worked.

The direction of the handshake also flipped: the platform used to mint the secret and the
vendor carried it to the bot. Now the bot mints it and the vendor carries it to the platform.
There is nothing to poll — the vendor types the code and the response tells you it worked.

---

## Putting it together (suggested UI flow)

For each channel card in the notification settings screen:

1. Read `*Verified` from `GET /api/vendor/notification-preferences`.
2. If **not verified** → show **Connect**. For email, send the verification link (above). For
   Telegram and WhatsApp, render `howToConnect` from `GET /api/me/connections` — the bot
   button plus the `/connect` command — and a single code input that posts to
   `POST /api/me/connections`.
3. If **verified** → show an **Enable** toggle that calls `PATCH /api/vendor/notification-preferences`.
   Remember enabling one secondary channel auto-disables the others (single-channel rule,
   priority telegram → email → whatsapp).
4. Language is set separately on the profile (`preferred_language`) — see
   [notifications.md](./notifications.md#notification-language).

> One code box serves both messaging channels — the code itself carries which channel it is
> for, so do not ask the vendor to pick.
