# Messaging Connections (WhatsApp / Telegram)

One mechanism connects **any** messaging channel to a platform account. It replaces the two
separate flows that existed before (WhatsApp `/link:CODE` verification and the Telegram
deep-link token), which disagreed on almost everything.

- **Base path**: `/api/me/connections`
- **Auth**: required, cookie or `Bearer`, **any role**. The connection binds to the *User*, so
  a person who is both a vendor and a customer connects once and it holds everywhere.
- **Envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md).

---

## The flow

The code is minted by the **bot**, not by the platform. That inversion is the design:

```
1. User opens the connections screen.
   GET /api/me/connections
   → for each unconnected channel, `howToConnect` says which bot and what to send.

2. User opens WhatsApp or Telegram and sends:  /connect

3. The bot replies with a 6-character code, e.g.  A7K9P2
   (valid 10 minutes, single use)

4. User types the code on the platform.
   POST /api/me/connections  { "code": "A7K9P2" }

5. The account is connected. The code is dead the instant it is used.
```

The user never carries a platform secret into a chat window, and the platform never has to
trust a webhook's claim about who sent a message.

> **The code is case-insensitive and forgiving.** `a7k9p2`, `A7K9-P2` and `A7K9P2` are the same
> code. `O` is read as `0`, and `I`/`L` as `1`. Send whatever the user typed — do not
> normalise, uppercase or strip it in the client.

---

## `GET /api/me/connections`

Every channel, connected or not, in one call — enough to render the whole screen.

```json
{
  "success": true,
  "data": {
    "connections": [
      {
        "channel": "whatsapp",
        "connected": true,
        "displayName": "Jane D.",
        "identityHint": "••••1234",
        "connectedAt": "2026-08-15T09:00:00.000Z"
      },
      {
        "channel": "telegram",
        "connected": false,
        "displayName": null,
        "identityHint": null,
        "connectedAt": null,
        "howToConnect": {
          "command": "/connect",
          "botHandle": "@JoviMallBot",
          "deepLink": "https://t.me/JoviMallBot"
        }
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `channel` | `whatsapp` \| `telegram`. Iterate the array — do not hardcode two cards |
| `connected` | the only flag that decides Connect vs Disconnect |
| `displayName` | the WhatsApp profile name or Telegram display name. May be `null` |
| `identityHint` | `••••1234` for WhatsApp, `@handle` for Telegram. **May be `null`** — render `displayName` alone then |
| `howToConnect` | present **only** when `connected` is `false` |
| `howToConnect.deepLink` | may be `null` if the bot is not configured server-side. Show `command` and `botHandle` as text in that case — the flow still works |

> **There is no phone number or chat id in this response, by design.** The raw messaging
> identifier never leaves the backend. `identityHint` is all the confirmation a settings screen
> needs, and it is not reversible.

> `deepLink` for WhatsApp pre-fills the message (`https://wa.me/<n>?text=%2Fconnect`).
> Telegram's cannot — it only opens the chat, and the user types `/connect`. Show the command
> next to the button on both.

---

## `POST /api/me/connections`

```json
{ "code": "A7K9P2" }
```

Returns the newly connected channel, in the same shape as a `GET` entry:

```json
{
  "success": true,
  "data": {
    "channel": "whatsapp",
    "connected": true,
    "displayName": "Jane D.",
    "identityHint": "••••1234",
    "connectedAt": "2026-08-15T09:04:11.000Z"
  },
  "message": "Connected"
}
```

**The client does not say which channel it is redeeming.** The code carries that. One input
box, one button.

**Re-connecting replaces.** If the caller already has a WhatsApp connection and redeems a code
for a different number, the new one wins. There is no "disconnect first" step.

### The linking rules, in full

| Situation | Outcome |
|---|---|
| The identity is connected to nobody | Connected. `200` |
| The identity is already connected to **this** account | **Idempotent success**, `200`. No duplicate row; the display name is refreshed |
| The identity is connected to **another** account | `409 MESSAGING_IDENTITY_ALREADY_LINKED`. Ownership is **never** transferred silently |
| This account already has a *different* identity on that channel | Replaced. The old one is dropped, the new one wins |
| The code expired | `400 CONNECTION_CODE_EXPIRED` |
| The code is wrong, malformed, or already spent | `400 CONNECTION_CODE_INVALID` |

> A code is single-use even when the redeem *fails*: it is spent by the attempt. So a `409`
> means send `/connect` again, not retry with the same code.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `CONNECTION_CODE_EXPIRED` | The code was real and is past its 10 minutes. **Actionable** — tell the user to send `/connect` again |
| 400 | `CONNECTION_CODE_INVALID` | Wrong, malformed, or already used — **one code for all three**, so a response cannot confirm whether a guessed code was ever real |
| 409 | `MESSAGING_IDENTITY_ALREADY_LINKED` | That messaging account belongs to a different platform account. `details.channel` says which |
| 429 | `CONNECTION_CODE_ATTEMPTS_EXCEEDED` | More than 5 attempts in 10 minutes, per account |
| 429 | `RATE_LIMIT_EXCEEDED` | More than 30 redeem calls a minute from this IP |
| 400 | `VALIDATION_ERROR` | `code` missing or absurdly long |

> **`EXPIRED` and `INVALID` are genuinely different and should read differently.** Expiry is the
> common failure — somebody read the code, got distracted, came back — and "send `/connect`
> again" is the fix. `INVALID` means check what you typed. Do not collapse them in the UI.
>
> The backend can only tell them apart for a limited window after expiry; an ancient code
> reads as `INVALID`. That is correct, not a bug: it is old enough that a fresh one is the
> answer either way.

> **`MESSAGING_IDENTITY_ALREADY_LINKED` says nothing about the other account, deliberately** —
> no email, no name, no masked identifier. Do not present it as "this number belongs to
> user X". The honest message is: this WhatsApp/Telegram account is connected elsewhere;
> disconnect it there first, or contact support.

> **Two rate limits guard this endpoint and they count different things.**
> `CONNECTION_CODE_ATTEMPTS_EXCEEDED` is per account (5 per 10 min); `RATE_LIMIT_EXCEEDED` is
> per IP address (30/min). A shared office network can hit the second without any one person
> hitting the first. Neither should be retried in a loop.

---

## `DELETE /api/me/connections/:channel`

`:channel` is `whatsapp` or `telegram`.

```json
{ "success": true, "data": null, "message": "Disconnected" }
```

| Status | `error.code` | When |
|---|---|---|
| 404 | `MESSAGING_CONNECTION_NOT_FOUND` | Nothing connected on that channel |
| 400 | `VALIDATION_ERROR` | `:channel` is not a known channel |

---

## Connecting is not the same as enabling

Two independent steps, and both are required before anything is delivered:

1. **Connect** the channel — this page.
2. **Enable** it in notification preferences (`PATCH /api/{vendor,agency,agent,customer}/notification-preferences`).

`GET …/notification-preferences` reports `whatsappVerified` / `telegramVerified`, which mirror
whether a connection exists. Only **one** secondary channel can be enabled at a time; enabling
one disables the others.

> ⚠️ **Changed:** Telegram used to have a third switch — `POST /webhooks/telegram/toggle` — which
> muted delivery *and* made `telegramVerified` report `false`, so a connected user's settings
> screen offered them "Connect" again. That endpoint is **gone**. `telegramEnabled` in
> notification preferences is now the only mute, exactly as WhatsApp already worked.

---

## What was removed

Every endpoint below is **deleted**, not deprecated.

| Gone | Replacement |
|---|---|
| `POST /api/auth/request-wa-verification` | `GET /api/me/connections` (instructions) + `POST /api/me/connections` (redeem) |
| `GET /api/webhooks/whatsapp/link/status` | `GET /api/me/connections` |
| `DELETE /api/webhooks/whatsapp/link` | `DELETE /api/me/connections/whatsapp` |
| `POST /api/webhooks/telegram/link-token` | `GET /api/me/connections` |
| `GET /api/webhooks/telegram/status` | `GET /api/me/connections` |
| `POST /api/webhooks/telegram/toggle` | nothing — use `telegramEnabled` in notification preferences |
| `POST /api/webhooks/telegram/disconnect` | `DELETE /api/me/connections/telegram` |

Four other things changed with them:

- **`wa` is gone from the profile payloads.** `GET /api/agent/profile`, `/api/agency/profile` and
  `/api/customer/profile` no longer carry `wa: { verified, name }`. Read connection state from
  `GET /api/me/connections`, which is the one source now.
- **Connections are no longer per-role.** The old WhatsApp status and unlink answered for
  whichever role the token was scoped to, and `update_other_roles` existed to paper over it.
  One person, one WhatsApp number, every role.
- **The bot commands changed.** `/link:CODE` and the Telegram `/start <token>` deep link are
  gone; both bots take `/connect`.
- **The endpoints moved off `/api/webhooks`.** They now sit under `/api/me`, so they are
  rate-limited like every other authenticated route.

## Related

- Per-role notification preferences: [`../vendor/notifications.md`](../vendor/notifications.md),
  `../agency/notifications.md`, `../agent/notifications.md`, `../customer/notifications.md`
- Channel setup walkthrough: [`../vendor/notification-channels.md`](../vendor/notification-channels.md)
- The bot webhooks themselves (not frontend endpoints):
  [`../whatsapp/README.md`](../whatsapp/README.md), [`../telegram/README.md`](../telegram/README.md)
