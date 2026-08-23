# Change Email / Phone API

Reference for changing the **email address or phone number an account signs in with**.

> [!IMPORTANT]
> Like [password.md](./password.md), this is a **shared, role-agnostic** surface mounted under
> `/api/me`. The same endpoints work for every authenticated role — the login identifiers live on
> the **User** record, not on any role entity, so there is one email and one phone per *account*
> regardless of how many roles it holds. When a change is confirmed it is carried onto **every**
> role profile the account has (customer, vendor, agency, agent), so the profile a notification
> reads and the identifier the sign-in resolves can never disagree.

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
| Proof of control | a token emailed to the **new address** | a **WhatsApp connection** on the new number |
| Confirm | `POST /api/auth/email-change/confirm` (**public**) | `POST /api/me/phone/confirm` (**authenticated**) |
| Cancel | `DELETE /api/me/email/pending` | `DELETE /api/me/phone/pending` |
| Window | 1 hour (`CONTACT_CHANGE_EMAIL_TTL_SECONDS`) | 24 hours (`CONTACT_CHANGE_PHONE_TTL_SECONDS`) |

### Why the phone flow has no OTP

There is deliberately **no SMS code and no WhatsApp code** on this platform, and this is the
answer a client should build against rather than wait for:

- This service integrates **no SMS provider**.
- A WhatsApp message to a number that has not messaged the bot is outside Meta's 24-hour service
  window, so it must be an approved **paid template** billed to a credit wallet — and a customer
  has no wallet.

What the platform already has is the *inbound* direction. A messaging connection
([connections/README.md](../connections/README.md)) exists only because a message arrived **from
that number** and the account holder redeemed the resulting code while signed in. That is a
stronger proof of control than an OTP, and it is already built — so the phone confirm requires it.

**Consequences a client must handle:**

- An account with **no WhatsApp connection** cannot change its phone. Send the user to the
  connections screen first.
- A **Telegram** connection does not count. A Telegram `chat_id` bears no relation to any phone
  number.
- The connected number must be **the number being claimed**, not merely any connected number.

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
> It is a **POST**, unlike the older `GET /api/auth/verify-email`. Mail clients and chat apps
> *prefetch* URLs to build preview cards, and a `GET` that mutates is spent by a crawler before
> the person taps it. The emailed link therefore points at
> **`<STOREFRONT_URL>/account/confirm-email?token=…`** — a page you serve, which reads the token
> out of the query string and POSTs it here.
>
> It sits under `/api/auth`, so it is bound by the **credential** rate-limit bucket
> (20/min/IP) — see [rate-limits.md](../rate-limits.md).

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
  "message": "Connect that number on WhatsApp, then confirm the change. Until you do, you still sign in with your current number."
}
```

**Errors** — the same three as `PATCH /api/me/email`.

**What the client should do next**: if the account has no WhatsApp connection on that number,
route the user through `POST /api/me/connections`
([connections/README.md](../connections/README.md)) — send `/connect` to the bot **from the new
number**, then redeem the 6-character code it replies with. Then call the confirm below.

---

## POST /api/me/phone/confirm

Complete a phone change, once the number is proved.

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
