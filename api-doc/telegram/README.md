# Telegram

Account linking is **not on this page any more.** It moved to
[`../connections/README.md`](../connections/README.md) — one mechanism for WhatsApp and
Telegram alike, mounted at `/api/me/connections`.

What remains here is the bot bridge and one admin endpoint. Neither is a frontend endpoint.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/webhooks/telegram/webhook` | public (bot bridge) | Inbound bot messages — **not** a frontend endpoint |
| `POST` | `/api/webhooks/telegram/send` | **admin** | Send a Telegram message to a user or chat |

## POST `/webhooks/telegram/webhook`

### ⚠ Authentication — `X-Webhook-Secret`

When `BOT_WEBHOOK_SECRET` is configured, this endpoint requires it as an `X-Webhook-Secret`
header; mismatch or absence → `401 WEBHOOK_SECRET_INVALID`. Unset means **refused in
production, open in development**. It became load-bearing with `/connect`, which mints a
connection credential for whatever identity the request names — see
[../whatsapp/README.md](../whatsapp/README.md#-authentication--x-webhook-secret) for the full
reasoning; it applies identically here.

### Request

Called by the automation layer that relays the Telegram bot. Dispatches `/`-commands through
the internal CommandBus. Four are registered: **`connect`**, **`login`**, **`reset_password`**
and **`login_contact`** — the last dispatched when an inbound message carries a `contact`, not
by a slash command anybody types.

```json
{
  "chat_id": "123456789",
  "user_id": "optional, if the bridge already resolved one",
  "is_command": true,
  "command": "connect",
  "payload": { "name": "Jane Doe", "username": "janedoe" }
}
```

`payload.name` and `payload.username` are optional and cosmetic — they become the display name
and `@handle` on the connection. The **identity** is `chat_id`, read from the context the
controller builds, never from `payload`.

Answers the automation layer, not a frontend, so it is one of the deliberate exceptions to the
`{ success, data }` envelope — the CommandBus result is returned verbatim:

```json
{
  "message": "Your connection code is: A7K9P2\n\nEnter this code on Jovi Mall to connect your Telegram account.\n…",
  "success": true,
  "channel": "telegram",
  "code": "A7K9P2",
  "expiresInSeconds": 600
}
```

**The automation layer must relay `message` to the chat verbatim.** This service does not send
it — see the WhatsApp page for why one relay path beats two outbound APIs.

### `login` and `login_contact` — passwordless customer sign-in

`command: "login"` mints a magic link and an 8-character code. Full contract in
[../auth/magic-login.md](../auth/magic-login.md).

**Telegram needs one extra step the first time**, because a `chat_id` bears no relation to any
phone number — a first-time sender is anonymous. When the chat is unknown, the result is a
prompt carrying a marker instead of credentials:

```json
{
  "message": "To sign you in, Telegram needs to confirm your phone number.…",
  "success": true,
  "channel": "telegram",
  "expiresInSeconds": 0,
  "requestContact": true
}
```

**`requestContact: true` is the automation layer's instruction to attach a `request_contact`
keyboard** ("Share my phone number"). When the user taps, Telegram sends a `contact` object
carrying a phone number **it verified at signup** — post that as `command: "login_contact"`:

```json
{
  "chat_id": "123456789",
  "is_command": true,
  "command": "login_contact",
  "payload": {
    "contact": { "phone_number": "+237600000000", "user_id": 123456789, "first_name": "Jane" },
    "from": { "id": 123456789 },
    "username": "janedoe"
  }
}
```

The reply is then exactly what `/login` returns — the user does **not** send `/login` again.
Every later `/login` from that chat is instant, and their Telegram notifications start working
with no separate `/connect`.

#### ⚠ One keyboard, two commands

**`/reset-password` (`command: "reset_password"`) also returns `requestContact: true`** on an
unknown chat, and its contact-share is posted as `login_contact` too — the same mapping. The
contact message carries the phone number and the sender and **nothing about which command was
asked**, so the platform records a short-lived pending intent when it renders the prompt and
reads it when the contact arrives.

**Nothing changes on the n8n side**: keep posting `login_contact` for any inbound contact. The
reply you get back is whichever command the user was answering — a sign-in session for
`/login`, a password-reset link for `/reset-password`. If no intent is on record (an unprompted
share, or one arriving more than 10 minutes later) it falls back to `login`, the lesser of the
two outcomes.

Unlike `login`, `reset_password` serves **every role** — vendor, agency, agent and customer.
See [../auth/magic-login.md](../auth/magic-login.md).

> ### ⚠ Forward the WHOLE contact, `user_id` included
>
> A Telegram user can share **somebody else's** contact card from their address book, and it
> arrives in the same shape. Only a contact whose `user_id` is the sender's own is accepted —
> without that check, forwarding a victim's contact would be a one-message account takeover.
>
> A missing or mismatched `user_id` is refused with **`400 MAGIC_CONTACT_UNVERIFIED`**, and
> **the automation layer must relay `error.message` on a 400** — that is how the refusal
> reaches the user. Its wording is written for a chat window and does not read as an
> accusation, because the ordinary way to hit it is tapping the wrong contact.
>
> `from.id` is optional; the chat id from the webhook body is the authority. In a private chat
> the two are the same number, and taking both sides of the comparison from the payload would
> make the guard forgeable by anyone who can reach the webhook.

> ⚠ As on WhatsApp, a `login` result carries **no `code` and no `token` field** — the
> credentials are inside `message` only. Relay it verbatim, store none of it, and set
> `disable_web_page_preview: true`.

## POST `/webhooks/telegram/send` (admin)

| Field | Type | Required | Validation |
|---|---|---|---|
| `userId` | string | conditionally | Provide **either** `userId` **or** `chatId` |
| `chatId` | string | conditionally | " |
| `message` | string | ✅ | 1–4096 chars |

`userId` is resolved through the caller's Telegram **connection**. An account with no Telegram
connection answers `400` with `"No Telegram account connected"`.

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing `message`, or neither `userId` nor `chatId` |
| `AUTH_MISSING_TOKEN` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Called by a non-admin |
| `INTERNAL_SERVER_ERROR` | 400/500 | No connection, or the Bot API rejected the send |

## Notes

- `TELEGRAM_BOT_TOKEN` must be configured or the channel is inert.
- `TELEGRAM_BOT_NAME` is what `GET /api/me/connections` uses to tell a user which bot to open.

## Related

- [../connections/README.md](../connections/README.md) — connecting an account (the replacement for the old linking flow)
- [../auth/magic-login.md](../auth/magic-login.md) — passwordless `/login`, both channels
- [../whatsapp/README.md](../whatsapp/README.md) — the WhatsApp bot bridge
