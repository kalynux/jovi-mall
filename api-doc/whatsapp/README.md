# WhatsApp

Account linking is **not on this page any more.** It moved to
[`../connections/README.md`](../connections/README.md) — one mechanism for WhatsApp and
Telegram alike, mounted at `/api/me/connections`. `GET /api/webhooks/whatsapp/link/status` and
`DELETE /api/webhooks/whatsapp/link` are **deleted**.

What remains here is the bot bridge. It is not a frontend endpoint.

| Endpoint | Auth |
|---|---|
| `POST /api/webhooks/whatsapp/` | none (public webhook) |

## ⚠ Authentication — `X-Webhook-Secret`

When `BOT_WEBHOOK_SECRET` is configured, every request to this endpoint must carry it as an
`X-Webhook-Secret` header. Mismatch or absence → `401 WEBHOOK_SECRET_INVALID`.

**Unset behaves differently by environment, deliberately:** in production the webhook is
refused outright; in development it stays open with a warning at boot.

This became load-bearing with the `/connect` command. The endpoint now **mints** a connection
code for whatever messaging identity the request names — so an open one lets anybody mint a
code against a stranger's number, read it from the response, and attach that number to their
own account. It is not a takeover of the victim's platform account, but it redirects their
notifications and locks them out of connecting (the identity is unique).

> Configuring it here means configuring the same value on the automation layer.

---

## Webhook (inbound messages)

Receives messages sent to the Jovi Mall WhatsApp business number, relayed by an automation
layer (n8n) rather than called by a frontend. Records the inbound message against the 24h
service window, then dispatches any `/`-command through the internal CommandBus — `/connect`
being the one that matters (see [../connections/README.md](../connections/README.md)).

- **Endpoint:** `POST /api/webhooks/whatsapp/`
- **Authentication:** none
- **Content-Type:** `application/json`

```json
{
  "reply_to": "1234567890",
  "wa_phone_id": "1234567890",
  "user_id": "optional, if the bridge already resolved one",
  "is_command": true,
  "command": "connect",
  "payload": { }
}
```

`reply_to` and `wa_phone_id` are the WhatsApp-assigned sender identifiers Meta puts on an
inbound webhook — digits with no leading `+`. They are **deliberately exempt** from the
platform's E.164 rule (`core/validation/phone`): they are not contact fields anybody typed,
and holding them to E.164 would reject every real webhook.

### Response `200`

Answers the automation layer, not a frontend, so it is one of the deliberate exceptions to the
`{ success, data }` envelope — the body below is sent verbatim.

```json
{
  "message": "Inbound recorded"
}
```

…plus whatever the dispatched command returned.

### The `connect` command

For `command: "connect"` the response carries:

```json
{
  "message": "Your connection code is: A7K9P2\n\nEnter this code on Jovi Mall to connect your WhatsApp account.\nIt expires in 10 minutes and can only be used once.\n\nNothing has been connected yet — this code does nothing until you enter it.\nIf you did not ask for it, ignore this message.",
  "success": true,
  "channel": "whatsapp",
  "code": "A7K9P2",
  "expiresInSeconds": 600
}
```

**The automation layer must relay `message` back to the sender verbatim.** This service does
not send the reply itself — one relay path with one failure mode beats two outbound APIs and a
code minted whether or not anyone received it. If the relay fails, nobody got a code and
`/connect` can simply be sent again.

Three properties worth knowing:

- **The identity comes from `reply_to`, never from `payload`.** The handler reads the sender
  the controller put in its context. A caller-supplied identity would let anyone name somebody
  else's number — the exact mistake the deleted `link` command made.
- **A second `/connect` invalidates the first code.** One identity holds at most one live code,
  however many times the user taps.
- **No account link is created here.** The code stands for the messaging identity alone; the
  binding happens at `POST /api/me/connections`, where a session says who is claiming it.

`payload.name` (WhatsApp profile name) is optional and cosmetic — it becomes the display name
on the connection.

### The `login` command

`command: "login"` mints a **passwordless customer sign-in**: a magic link and an 8-character
code, both for one session, both good for 10 minutes, and using either kills the other. Full
contract in [../auth/magic-login.md](../auth/magic-login.md).

```json
{
  "message": "Tap to sign in on this device:\nhttps://shop.example.com/login/magic?t=Xk3…\n\nOr go to shop.example.com and sign in with your phone number and this code:\n4B2K91QN\n\nBoth expire in 10 minutes and can be used once.\nIf you did not ask to sign in, ignore this message.",
  "success": true,
  "channel": "whatsapp",
  "expiresInSeconds": 600
}
```

> ### ⚠ Unlike `connect`, the result carries NO `code` and NO `token` field
>
> `connect` returns `code` beside `message` for the automation layer's convenience. These are
> **session credentials**, and a webhook response body is logged in more places than a chat
> message — n8n execution history, HTTP request logs, an error report. `message` carries them
> because it must; nothing else does, and neither is ever written to a log line.
>
> **Relay `message` verbatim and store none of it.** Disable link previews on the reply
> (`preview_url: false`).

A refusal is also a `200` with a `message` to relay, and `success: false`:

```json
{ "message": "I don't recognise this number. Create an account on the website first, then send /login again.", "success": false, "channel": "whatsapp" }
```

`login` resolves the sender by matching `reply_to` against the account's phone number, so
WhatsApp needs no extra step — the sender id **is** the number. (Telegram does; see
[../telegram/README.md](../telegram/README.md).) On success the WhatsApp account is also
**connected**, so notifications start working with no separate `/connect`.

### The `reset_password` command

`command: "reset_password"` (underscore — the user types `/reset-password`) replies with a
password-reset link: the same one `POST /auth/forgot-password` emails, with the same token,
the same 30 minutes and the same single use.

```json
{
  "message": "Tap to choose a new password:\nhttps://shop.example.com/reset-password?token=a3f…\n\nThis link expires in 30 minutes and can be used once.\nYour password has not changed yet — nothing happens until you set a new one.\nIf you did not ask for this, ignore this message.",
  "success": true,
  "channel": "whatsapp",
  "expiresInSeconds": 1800
}
```

> **Unlike `login`, this serves EVERY role** — vendor, agency, agent and customer. A password
> belongs to the account, not to a role, so it is the only self-service recovery a vendor or
> agency has from a chat. Full contract in [../auth/magic-login.md](../auth/magic-login.md).

> As with `login`, the result carries **no token field** — the link is inside `message` only.
> Relay it verbatim and store none of it.

## Notes

- `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` must **both** be set or the channel
  reports itself unconfigured and every notification handler silently skips it.
- `WA_BOT_NUMBER` is what `GET /api/me/connections` uses to build the "message this number"
  instruction and the `wa.me` deep link.

## Related

- [../connections/README.md](../connections/README.md) — connecting an account (the replacement for the old linking flow)
- [../auth/magic-login.md](../auth/magic-login.md) — passwordless `/login`, both channels
- [../notifications/whatsapp-templates.md](../notifications/whatsapp-templates.md) — approved templates
- [../telegram/README.md](../telegram/README.md) — the Telegram bot bridge
