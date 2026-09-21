# Change Email / Phone API

**Verified against source on 2026-09-08** — all six routes, all six `CONTACT_CHANGE_*` codes with
their statuses and derived categories, the 1-hour email token TTL and 24-hour phone TTL, and the
optional `app=` role key, against `jovi-mall/src/modules/users/services/contact-change.service.ts`
and `src/modules/users/config/contact-change.config.ts`.

Reference for changing the **email address or phone number an account signs in with**.

> [!IMPORTANT]
> Like [password.md](./password.md), this is a **shared, role-agnostic** surface mounted under
> `/api/me`. The same endpoints work for every authenticated role — the login identifiers live on
> the **User** record, not on any role entity, so there is one email and one phone per *account*
> regardless of how many roles it holds. When a change is confirmed it is carried onto **every**
> role profile the account has (customer, vendor, agency, agent), so the profile a notification
> reads and the identifier the sign-in resolves can never disagree.

> [!NOTE]
> **There is a SECOND door onto these five verbs, and it is not a proxy.** Since MCP parity
> step 6 the bot surface serves them at `/api/internal/bot/contact*` for a customer resolved
> from a messaging identity — same services, same rules, one addition and one absence:
>
> - it reports **`phoneChangeProved`**, which answers whether the pending phone change can be
>   completed at all (see the phone proof below). The customer API does not, so a browser
>   client finds out from the `422` after trying;
> - there is **no bot equivalent of the email confirm**, because that endpoint is
>   unauthenticated by design and its token arrives in a mail client.
>
> Contract: `api-doc/n8n/bot-surface.md` § 15.

---

## The one rule that shapes everything below

**The identifier does not move until the change is proved.**

`POST /api/auth/login` resolves an account by `login_email` / `login_phone`. A flow that wrote the
new value immediately and flagged it unverified would be unrecoverable from a typo: the account
could no longer be signed into, and the correction form is behind the sign-in.

So a request writes a **pending** change and nothing else. Until it is confirmed:

- the **current** identifier still signs in, unchanged;
- the **new** one does not;
- `GET /api/me/contact` reports both, so a client can render "waiting on `new@example.com`".

Confirming swaps them in a single write. The old identifier stops working at exactly the moment
the new one starts — there is no window in which both work, and none in which neither does.

> [!NOTE]
> A contact change is **not** a credential change: it does **not** sign your other devices out.
> Only `PATCH /api/me/password` does that. If you believe an account is compromised, change the
> password — that is the remedy that evicts sessions.

---

## Authentication

Every endpoint here requires a valid access token **except**
[`POST /api/auth/email-change/confirm`](#post-apiauthemail-changeconfirm), which is public by
design — see that section.

```
Authorization: Bearer <access_token>
```

The token may also be supplied via the `access_token` httpOnly cookie (browser clients). Standard
envelope throughout; see [errors/README.md](../errors/README.md).

---

## The two flows at a glance

| | Email | Phone |
|---|---|---|
| Request | `PATCH /api/me/email` | `PATCH /api/me/phone` |
| Proof of control | a token emailed to the **new address** | a **six-digit WhatsApp code** sent to the new number |
| Confirm | `POST /api/auth/email-change/confirm` (**public**) | `POST /api/me/phone/verify/request`, then `POST /api/me/phone/verify/confirm` (**authenticated**) — [phone-verification.md](phone-verification.md) |
| Cancel | `DELETE /api/me/email/pending` | `DELETE /api/me/phone/pending` |
| Window | 1 hour (`CONTACT_CHANGE_EMAIL_TTL_SECONDS`) | 24 hours (`CONTACT_CHANGE_PHONE_TTL_SECONDS`) |

### The phone proof is a WhatsApp code

**Every client, the storefront included, confirms a phone change with a six-digit code sent to
the new number on WhatsApp** (owner decision, 2026-09-21):

```
PATCH /api/me/phone               { "phone": "+237600000002" }   → pending, nothing moves yet
POST  /api/me/phone/verify/request                               → code sent to the NEW number
POST  /api/me/phone/verify/confirm  { "code": "123456" }         → login_phone swaps
```

The code goes out as free text inside Meta's 24-hour window and as the approved AUTHENTICATION
template outside it, so the user never has to message the bot first. It is not billed to anyone.
Refusals, limits and the "what to show on failure" contract are in
[phone-verification.md](phone-verification.md).

⚠ **The account's WhatsApp link moves with the number.** If the account was linked to the bot
from the number being given up, confirming the code moves that link to the new number. Otherwise
whoever holds the old number, a lost or recycled SIM, would still be this customer to the bot,
and notifications would keep going there. If the new number is already linked to a different
account, the link is removed instead of transferred.

⛔ **This section used to say the platform had "deliberately no WhatsApp code"**, and that the
only proof was a messaging connection: send `/connect` to the bot **from the new number**, redeem
the code, then call `POST /api/me/phone/confirm`. That flow still works and the bot surface uses
it (`contact_confirm_phone`), but **the storefront must not send customers through it**. Remove
any "message the bot from your new number" copy that was built from the old text.

---

## GET /api/me/contact

What the account signs in with, and what is waiting.

**Response (200 OK)**

```json
{
  "success": true,
  "data": {
    "email": "old@example.com",
    "phone": "+237600000001",
    "pendingEmail": {
      "target": "new@example.com",
      "requestedAt": "2026-08-21T09:00:00.000Z",
      "expiresAt": "2026-08-21T10:00:00.000Z"
    },
    "pendingPhone": null
  }
}
```

`email` and `phone` are each `string | null` — an account may hold only one of the two.
`pendingEmail` / `pendingPhone` are `null` when nothing is in flight. **No token is ever
returned**, in this or any other response.

---

## PATCH /api/me/email

Open a change of login email. Sends a confirmation link **to the new address**.

**Request**

```json
{ "email": "new@example.com" }
```

`email` (**required**, string) — validated against the platform's shared RFC-shaped rule and
normalised (trimmed, lowercased). The schema is `.strict()`: an unknown key is a `400`, not a
silently stripped field. `null` and `""` are refused — **clearing a login identifier is not a
self-service operation** (an account must keep at least one, and only an administrator may edit
them freely).

**Response (200 OK)**

```json
{
  "success": true,
  "data": {
    "pendingEmail": {
      "target": "new@example.com",
      "requestedAt": "2026-08-21T09:00:00.000Z",
      "expiresAt": "2026-08-21T10:00:00.000Z"
    }
  },
  "message": "Check the new address for a confirmation link. Until you confirm it, you still sign in with your current email."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 422 | `CONTACT_CHANGE_SAME_IDENTIFIER` | It is already the address on the account |
| 409 | `CONTACT_CHANGE_IDENTIFIER_TAKEN` | Another account holds it |
| 400 | `VALIDATION_ERROR` | Malformed, missing, or an unknown key |

> A second request **supersedes** the first: the earlier link stops working. That is the correct
> behaviour for a mistyped address — retype it and the wrong link dies, rather than two links
> racing.

---

## POST /api/auth/email-change/confirm

Spend the token from the email and complete the change.

> [!IMPORTANT]
> **Public — no access token.** The link is read in a mail client, which is routinely a different
> browser and often a different device from the one that started the change. Requiring the session
> would fail the flow for exactly the people it is for. The token is the credential and it names
> the account.
>
> It is a **POST**, for the reason `POST /api/auth/verify-email` is one: mail clients and chat
> apps *prefetch* URLs to build preview cards, and a `GET` that mutates is spent by a crawler
> before the person taps it. The emailed link therefore points at a page you serve, which reads
> the token out of the query string and POSTs it here:
>
> ```
> <STOREFRONT_URL>/account/confirm-email?token=<64 hex>&app=<customer|vendor|agency|agent>
> ```
>
> It sits under `/api/auth`, so it is bound by the **credential** rate-limit bucket
> (20/min/IP) — see [rate-limits.md](../rate-limits.md).

> [!NOTE]
> **`app` names which app opened the change, and it is optional.**
>
> One page serves the storefront, both dashboards and the agent app, because this endpoint is
> genuinely role-free: it reads no token of yours, resolves the account from the confirmation
> token, and syncs the confirmed address onto **every** role profile the account holds. So the
> response carries `{ email }` and no role — an account can hold several, and a `roles` array
> would not identify one destination anyway.
>
> The only thing the page cannot work out for itself is **where to send the person afterwards**,
> which is what `app` answers. It is stamped from the JWT by `PATCH /api/me/email` — the half of
> the flow that has a session.
>
> **Treat it as a key, never a URL.** Map it through a compile-time table and ignore anything
> else; this page is reachable with no session, so honouring a caller-supplied destination would
> be an open redirect on the origin your sign-in pages live on. Links already in inboxes carry no
> `app=`, so absence must be normal — fall back to your default destination.

**Request**

```json
{ "token": "…64 hex characters…" }
```

**Response (200 OK)**

```json
{
  "success": true,
  "data": { "email": "new@example.com" },
  "message": "Your email address has been changed. Use it to sign in from now on."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `CONTACT_CHANGE_TOKEN_INVALID` | Unknown, already spent, or superseded by a newer request |
| 422 | `CONTACT_CHANGE_EXPIRED` | Past the one-hour window — start again |
| 409 | `CONTACT_CHANGE_IDENTIFIER_TAKEN` | Somebody claimed the address while the link sat in a mailbox |

> The uniqueness check runs **again** here, and that is not redundant: the address is claimable in
> the up-to-an-hour window between request and confirm.

**This endpoint does not sign the user in.** After a success, a signed-out visitor should be sent
to the login screen (with the new address prefilled); a signed-in one keeps their session, which
is unaffected.

---

## DELETE /api/me/email/pending

Abandon a pending email change. The current identifier is untouched.

**Response (200 OK)** — `data: null`, with a message.

| Status | Code | When |
|---|---|---|
| 409 | `CONTACT_CHANGE_NOT_PENDING` | Nothing in flight |

---

## PATCH /api/me/phone

Open a change of login phone.

**Request**

```json
{ "phone": "+237600000002" }
```

`phone` (**required**, string) — **strict E.164**, the same rule every other phone field on this
platform uses: a leading `+`, country code, no spaces or punctuation. `.strict()`, and `null` /
`""` are refused, exactly as for email.

**Response (200 OK)**

```json
{
  "success": true,
  "data": {
    "pendingPhone": {
      "target": "+237600000002",
      "requestedAt": "2026-08-21T09:00:00.000Z",
      "expiresAt": "2026-08-22T09:00:00.000Z"
    }
  },
  "message": "Confirm the change with the code we send to that number on WhatsApp. Until you do, you still sign in with your current number."
}
```

**Errors** — the same three as `PATCH /api/me/email`.

**What the client should do next**: call `POST /api/me/phone/verify/request` (no body). The
server sends the code to the **pending** number, not the current one, and
`POST /api/me/phone/verify/confirm` with that code completes the change
(`data.changed: true`). See [phone-verification.md](phone-verification.md).

⚠ This call does **not** send the code by itself. Request it explicitly: sending it here would
start the 60-second resend cooldown, and the explicit request that every client already makes
next would then be refused with `429`.

---

## POST /api/me/phone/confirm

Complete a phone change, once the number is proved **by a WhatsApp connection**.

⚠ **The storefront does not use this route.** It confirms with the code (above). This one stays
for the bot surface (`contact_confirm_phone`), where the customer is already chatting from a
WhatsApp number, and for an account whose link already is the new number.

**Authenticated, and takes no body.** There is no token to present: the proof is a property of the
account, so the session is what makes it lookupable at all.

**Response (200 OK)**

```json
{
  "success": true,
  "data": { "phone": "+237600000002" },
  "message": "Your phone number has been changed. Use it to sign in from now on."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 422 | `CONTACT_CHANGE_PHONE_UNPROVEN` | No WhatsApp connection on this account matches the pending number. `details.channel` is `"whatsapp"` |
| 409 | `CONTACT_CHANGE_NOT_PENDING` | Nothing in flight, or it was superseded |
| 422 | `CONTACT_CHANGE_EXPIRED` | Past the 24-hour window |
| 409 | `CONTACT_CHANGE_IDENTIFIER_TAKEN` | Another account claimed the number in the meantime |

`CONTACT_CHANGE_PHONE_UNPROVEN` is the one to build a real screen for — it is not an error state
so much as the next step, and its message says so.

---

## DELETE /api/me/phone/pending

Abandon a pending phone change. Same shape and same single error as the email cancel.

---

## Error codes, in one list

| Code | Status | Category |
|---|---|---|
| `CONTACT_CHANGE_SAME_IDENTIFIER` | 422 | `business_rule` |
| `CONTACT_CHANGE_IDENTIFIER_TAKEN` | 409 | `conflict` |
| `CONTACT_CHANGE_NOT_PENDING` | 409 | `conflict` |
| `CONTACT_CHANGE_EXPIRED` | 422 | `business_rule` |
| `CONTACT_CHANGE_TOKEN_INVALID` | 400 | `validation` |
| `CONTACT_CHANGE_PHONE_UNPROVEN` | 422 | `business_rule` |

Branch on `error.code`, never on `error.message`. See [errors/README.md](../errors/README.md).
