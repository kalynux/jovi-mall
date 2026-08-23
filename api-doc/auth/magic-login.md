# Bot sign-in and password recovery — `/login` and `/reset-password`

Two commands on the same bots. **`/login`** signs a *customer* in without a password;
**`/reset-password`** hands *any* account — vendor, agency, agent or customer — the same reset
link `POST /auth/forgot-password` sends by email and WhatsApp. See
[`/reset-password`](#reset-password--a-reset-link-from-a-chat-any-role) below.

> **This page is the endpoint-level contract.** If you are building the storefront and want the
> customer's flow end to end — where registration happens, what to deep-link, what page you owe,
> and what not to build — start at **[customer-auth.md](./customer-auth.md)**.

---

## Passwordless sign-in — `/login`

A customer sends `/login` to the bot and gets **two credentials for one session**: a magic
**link** to tap, and an 8-character **code** to type. Either signs them in; using one kills the
other; both expire in 10 minutes.

- **Base path**: `/api/auth/magic`
- **Auth**: none — these endpoints are *how* a caller becomes authenticated
- **Envelope**: standard `{ success, data, message? }` — see [README.md](./README.md)
- **Delivery**: two HttpOnly cookies, exactly like `POST /auth/login`. **No tokens in the body.**

> **A `/login` session is always scoped to `customer`.** No other role is reachable this way,
> whatever else the account holds, and a customer role is **never auto-provisioned**. A vendor,
> agency or agent who messages the bot is told to sign in with their password.

---

## The flow

```
Customer sends  /login  to the WhatsApp or Telegram bot
        │
        ├── the bot replies with TWO credentials for the SAME session:
        │
        │   1. a magic LINK        → tap it, signed in on that device
        │   2. an 8-character CODE → type it on the site with your phone or email
        │
        └── both expire in 10 minutes; using either kills the other
```

Two credentials because they solve different problems. The link is for the phone already in the
user's hand — one tap, no typing. The code is for the desktop in front of them when WhatsApp is
on a phone across the room.

### What the bot replies

```
Tap to sign in on this device:
https://shop.example.com/login/magic?t=Xk3…

Or go to shop.example.com and sign in with your phone number and this code:
4B2K91QN

Both expire in 10 minutes and can be used once.
If you did not ask to sign in, ignore this message.
```

---

## ⚠ The magic link points at the STOREFRONT, not at this API

`STOREFRONT_URL/login/magic?t=…`. That page must **POST the token** to
`/api/auth/magic/link`. Two reasons, and the first is a live bug if ignored:

- **Link previews would spend the token.** WhatsApp and Telegram *fetch* URLs to build preview
  cards. A `GET` endpoint that signs you in is consumed by the crawler before the user ever
  taps — a dead link, every time, for every user. A `POST` from a page the crawler does not
  execute cannot be triggered that way.
- It follows the password-reset precedent, recorded there for the same reason: a browser flow
  needs a page, and only the frontend has one.

**The frontend owes one page**: `/login/magic`, which reads `?t=`, POSTs it, and redirects on
success. It should show a spinner, not a button — the user already expressed intent by tapping.

---

## `POST /api/auth/magic/link`

Redeem the magic link.

```json
{ "token": "Xk3vQ7…" }
```

### Response `200`

```json
{
  "success": true,
  "data": { "role": "customer", "user": { "…": "…" } },
  "message": "Signed in"
}
```

Sets `access_token` (15 min) and `refresh_token` (30 days), both HttpOnly. From here the session
is indistinguishable from a password login — same claims, same lifetimes, same revocation.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 401 | `MAGIC_LINK_INVALID` | Unknown, malformed, or already spent |
| 401 | `MAGIC_LINK_EXPIRED` | Real, and past its 10 minutes |
| 403 | `AUTH_ACCOUNT_SUSPENDED` | The account was suspended after the link was minted |
| 403 | `AUTH_ROLE_NOT_FOUND` | The customer role was removed after the link was minted |
| 404 | `AUTH_PROFILE_NOT_FOUND` | The customer profile was deleted after the link was minted |
| 400 | `VALIDATION_ERROR` | `token` missing or absurdly long |

> **401, not 400.** These are credentials, and the remedy is to obtain another one — send
> `/login` again. Treat both as "ask the bot for a new link", and do not retry the same token.

---

## `POST /api/auth/magic/code`

Redeem the typed code, paired with the account's phone number or email address.

```json
{ "identifier": "+237600000000", "code": "4B2K91QN" }
```

| Field | Notes |
|---|---|
| `identifier` | A phone number **or** an email address — the same field `POST /auth/login` takes. Phones must be E.164; emails are lowercased for you |
| `code` | Case-insensitive and forgiving: `4b2k-91qn`, `4B2K 91QN` and `4B2K91QN` are the same code. `O` reads as `0`, `I`/`L` as `1`. **Send whatever the user typed** — do not normalise, uppercase or strip it in the client |

### Response `200`

Identical to the link endpoint.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 401 | `MAGIC_CODE_INVALID` | Wrong code, unknown identifier, already spent, **or** a code belonging to a different account — **one code for all four** |
| 401 | `MAGIC_CODE_EXPIRED` | Real, matched to this identifier, and past its 10 minutes |
| 429 | `MAGIC_ATTEMPTS_EXCEEDED` | More than 5 attempts in 10 minutes against this identifier |
| 403 | `AUTH_ACCOUNT_SUSPENDED` | Suspended after minting |
| 403 | `AUTH_ROLE_NOT_FOUND` | Customer role removed after minting |
| 404 | `AUTH_PROFILE_NOT_FOUND` | Customer profile deleted after minting |
| 400 | `VALIDATION_ERROR` | `identifier` is not a well-formed phone or email, or `code` is missing |

> ### ⚠ `MAGIC_CODE_INVALID` is deliberately undifferentiated
>
> Unknown identifier, wrong code, expired-and-swept, and a code/identifier mismatch all answer
> the same way. Anything else would make this endpoint a **registration oracle** — post a phone
> number with a junk code and learn from the error whether that person shops here, for any
> number, with no account required.
>
> So do not write UI that says "no account with that number". The honest message is: *that code
> did not work — send `/login` again for a new one.*
>
> `MAGIC_CODE_EXPIRED` is the one exception, and it is only ever reached **after** the code has
> been matched to the account the identifier names — so it confirms nothing to a guesser.

> **A code is spent by the attempt, even when the attempt fails.** A `401` means send `/login`
> again, not retry with the same code.

---

## Telegram needs one extra step, once

WhatsApp's sender id **is** the phone number, so it matches the account directly — possession is
proved by the message itself, the same model as an SMS OTP. A Telegram `chat_id` bears no
relation to any phone number, so a first-time Telegram sender is anonymous to the platform.

```
/login  from an unknown Telegram chat
   → bot replies with a "Share my phone number" button   (result carries requestContact: true)
   → user taps; Telegram sends a contact it VERIFIED at signup
   → the platform matches the phone, persists the mapping, and mints the credentials
   → every later /login from that chat is instant
```

The user does **not** send `/login` again — the contact message completes the flow.

> ### ⚠ Only the sender's OWN contact is accepted
>
> A Telegram user can share **somebody else's** contact card from their address book, and it
> arrives in the same shape. Without a check, forwarding a victim's contact would be a
> one-message account takeover. Only a contact whose Telegram `user_id` is the sender's own is
> accepted; a missing or mismatched one is **refused outright**, never treated as a hint.
>
> The refusal is `400 MAGIC_CONTACT_UNVERIFIED`, and its message is written for a chat window —
> the ordinary way to hit it is tapping the wrong contact, not an attack.

A pleasant side effect: a customer who signs in via Telegram has **connected** Telegram by doing
so, and their Telegram notifications start working with no extra step. Same for WhatsApp. See
[../connections/README.md](../connections/README.md).

### Bot refusals

Returned as the reply text, so the user is always told something:

| Situation | Reply |
|---|---|
| No matching account | "I don't recognise this number. Create an account on the website first…" |
| Account holds no `customer` role | "This number is registered as a business account rather than a shopping account…" |
| Account not active | "This account is not active. Please contact support." |
| That Telegram chat belongs to another account | "This Telegram account is already connected to another account." |

> **The first row is transitional copy.** Customer accounts are created on the person's first
> interaction with the bot, so a sender with no account will be registered rather than turned
> away — that is bot-side work landing with the n8n integration, and `LOGIN_REFUSALS.no_account`
> changes with it. **Nothing on the frontend depends on it**: the reply is relayed verbatim by
> the automation layer and no `/auth/magic/*` response shape is involved. See
> [customer-auth.md](./customer-auth.md#1-registration--send-them-to-the-bot).
>
> The other three rows are stable. `not_customer` in particular is a rule, not a gap — **a
> customer role is never auto-provisioned onto a business account**, whatever registration does
> for a brand-new number.

> Telling senders their own number is unrecognised leaks nothing — they control it. The platform
> deliberately does **not** mint a decoy credential to disguise the answer; that would strand a
> real user with a code that can never work.

---

## Rate limiting

| Layer | Scope | Ceiling |
|---|---|---|
| Global | IP | 1200/min |
| Credential bucket (inherited from the `/api/auth` mount) | IP | **20/min** |
| Per-identifier attempts | the targeted account | **5 per 10 min** |
| Per-identity mints | the messaging account | 1 live pair — a second `/login` revokes the first |

The attempt counter is keyed on a **hash** of the normalised identifier, and `+237 600 000 000`
and `+237600000000` share one counter. A second `/login` from the same chat invalidates the
previous link *and* code, so one person never holds more than one live pair.

---

## ⚠ Customers are passwordless in practice

Customers are now registered with a **system-generated password that is hashed and never
disclosed to anybody, including them**. Three consequences:

- **A customer account is created in the bot, on first contact.** The storefront calls no
  registration endpoint and shows no signup form — it deep-links the person into WhatsApp or
  Telegram. See [customer-auth.md](./customer-auth.md#1-registration--send-them-to-the-bot).
- **`POST /auth/register` no longer requires `password` for `role: "customer"`**, and **ignores
  one if sent**. Accepting a caller-supplied password would create accounts whose password
  somebody else chose and knows. Every other role still requires it, unchanged. The endpoint
  still works — it is simply not the storefront's path.
- **`POST /auth/login` will always fail for a customer who has never run a password reset** —
  correctly, since there is no password to present. **The storefront's sign-in form should route
  customers to the messaging flow rather than showing them a password field that cannot work.**
- A customer who wants a real password can get one two ways: `POST /auth/forgot-password`,
  which delivers over **email *and* WhatsApp** keyed on the phone number, or **`/reset-password`
  in the bot** — see above. Both mint the same token.

> **One consequence accepted deliberately:** `password_changed_at` is this service's only
> session-revocation lever, and a customer who has never reset has never set it. Combined with
> the sliding 30-day refresh, a stolen customer session currently has no revocation path. That is
> pre-existing and not this feature's to fix — but this feature makes sessions much easier to
> obtain, so "sign out everywhere" is worth deciding on.

---

## `/reset-password` — a reset link from a chat, ANY role

```
Customer / vendor / agency / agent sends  /reset-password  to the bot
        │
        └── the bot replies with a link to choose a new password
            — the SAME link POST /auth/forgot-password sends by email and WhatsApp
```

```
Tap to choose a new password:
https://shop.example.com/reset-password?token=a3f…

This link expires in 30 minutes and can be used once.
Your password has not changed yet — nothing happens until you set a new one.
If you did not ask for this, ignore this message.
```

Redeemed by the existing **`POST /auth/reset-password`** with `{ token, newPassword }` — the
same token, the same 30-minute lifetime, the same single-use rule, and the same
`password_changed_at` stamp that revokes every other live session. **This is a new entrance,
not a second reset mechanism.**

### ⚠ It serves every role, and `/login` does not

| | `/login` | `/reset-password` |
|---|---|---|
| Who | **customers only** | **any role** — vendor, agency, agent, customer |
| Mints | a customer session (link + code) | a password-reset link |
| Lifetime | 10 minutes | 30 minutes |
| Needs a customer profile | yes | **no** |

A password belongs to the account, not to a role. Gating a reset on the customer role would
lock out exactly the people most likely to have a password to forget — customers largely do not
have one at all. So `/reset-password` is both the **only self-service recovery a vendor or
agency has from a chat**, and the route by which a passwordless customer acquires a real
password.

> **Link previews are harmless here**, unlike the magic sign-in link. This URL is a page; its
> token is spent by the form's `POST`, so a crawler fetching it changes nothing. Disabling
> previews is still tidier.

### Refusals

| Situation | Reply |
|---|---|
| No matching account | "I don't recognise this number. If you have an account, send /reset-password from the number you registered with…" |
| Account not active | "This account is not active, so its password cannot be reset. Please contact support." |
| That Telegram chat belongs to another account | "This Telegram account is already connected to another account." |

> **Why this may say "no account" when `POST /auth/forgot-password` may not.** That endpoint
> must answer identically for a real and an imaginary account, because an anonymous caller can
> feed it a list of phone numbers. A bot caller has already *proved* they control the messaging
> account, so telling them their own number is unrecognised discloses nothing. The enumeration
> oracle needs an attacker who can choose the identifier, and here they cannot.

### Telegram: one keyboard, two commands

`/reset-password` hits the same wall as `/login` on an unknown chat and answers it the same
way — `requestContact: true`. **The contact message that comes back says nothing about which
command was asked**, so the platform records a short-lived pending intent when it renders the
prompt and reads it when the contact arrives.

**n8n is unaffected**: it still posts `login_contact` for any inbound contact. The reply it
gets back is whichever command the user was actually answering, and they never have to send the
original command again.

> If no intent is on record — an unprompted contact-share, or one arriving more than 10 minutes
> later — it falls back to `login`. That is the lesser of the two outcomes: a session the sender
> could have had by typing `/login`, rather than a password-reset credential nobody asked for.

---

## A third entrance — an operator sends the link

Both credentials above have an administrator-initiated twin on the internal admin surface, for
support:

| Route | Mints | For |
|---|---|---|
| `POST /api/internal/admin/users/:userId/login-link` | the **same** 10-minute, single-use, `customer`-scoped session credential as `/login` | customers only |
| `POST /api/internal/admin/users/:userId/password-reset-link` | the **same** 30-minute reset token as `/reset-password` | any role |

Body is `{ channel: 'email' | 'whatsapp' | 'telegram' }` and nothing else. **A third entrance,
never a third mechanism**: both go through the machinery on this page, so the lifetime, the
single-use rule, the re-checked gates and the redemption endpoints are identical — a magic link
sent by an operator lands on the same `/login/magic` page and the same `POST /auth/magic/link`.

Three properties are worth knowing because they are what keep it from being a way to *obtain*
somebody's account rather than return it:

- **The destination is not in the request.** It is read from the party's own record. A caller who
  could name it could mail themselves a working credential for another person's account.
- **The response carries a masked destination and no token** (`+2376••••4417`, `j••••@example.com`).
- **The login link is customers only, and the split is the same one `/login` makes** — a vendor,
  agency or agent reaches money and other people's data, so they get a reset link instead.
- Rate-limited on both axes: **3 links per party per hour** (a harassment and SMS-bill bound) and
  **30 per administrator per hour** (a compromised or careless operator account). Neither
  substitutes for the other.

Not a storefront surface — it lives on the admin dashboard, and `mintForAdministrator` keys the
credential on the **target user**, not the operator, so two operators helping one customer leave
one live credential rather than two.

---

## Bearer clients — `/api/auth/mobile/magic/*`

The two endpoints above set cookies, which is right for the website: the magic link opens the
system browser and the code is typed on a page. **A Capacitor WebView can use neither**, and
neither fact is fixable in the client — its origin is `capacitor://localhost` (iOS) or
`https://localhost` (Android), which makes our cookie third-party and blocked by default, and
`Set-Cookie` is a *forbidden response-header name* in the Fetch standard, stripped from every
`Response.headers` object in every engine, so it cannot scrape the token out either.

So the customer app calls the bearer twin instead. Same service, same JWTs, same lifetimes, same
error codes, same **strict 20/min credential bucket** — the only difference is delivery.

| Cookie | Bearer |
|---|---|
| `POST /api/auth/magic/link` | `POST /api/auth/mobile/magic/link` |
| `POST /api/auth/magic/code` | `POST /api/auth/mobile/magic/code` |

Request bodies are identical. The response adds `data.tokens` and sets no cookie:

```json
{
  "success": true,
  "data": {
    "role": "customer",
    "user": { "…": "…" },
    "tokens": {
      "accessToken": "eyJ…",
      "refreshToken": "eyJ…",
      "accessExpiresIn": 900,
      "refreshExpiresIn": 2592000
    }
  },
  "message": "Signed in"
}
```

> **This is the only way the customer app can sign anybody in.** A customer's password is
> system-generated and disclosed to nobody, so `POST /api/auth/mobile/login` can never work for
> one — these two routes are their entire authentication surface.

From here the app holds the pair and sends `Authorization: Bearer <accessToken>` on every
request; `requireAuth` prefers the bearer over any cookie. Rotate through
`POST /api/auth/mobile/refresh`, and call `GET /api/auth/mobile/auth-me/customer` on launch —
that is the endpoint that re-issues **both** tokens at full lifetime and so restarts the 30-day
window. See [FRONTEND-CHANGELOG-mobile-auth.md](./FRONTEND-CHANGELOG-mobile-auth.md).

The app's origin must be in `ALLOWED_ORIGINS`; both Capacitor origins already are.

---

## The automation layer (n8n) — required, and the feature is inert without it

Outside this repository:

- map `/login` → `command: "login"`, and **relay `message` verbatim**
- map `/reset-password` → `command: "reset_password"` (underscore), and relay `message` verbatim
- render a `request_contact` keyboard when the result carries `requestContact: true` — both
  commands can return it
- detect an inbound `contact` and post it as `command: "login_contact"`, forwarding the whole
  `contact` object (including `user_id`) and, optionally, `from.id`. **One mapping serves both
  commands** — the platform decides which one it completes
- **relay `error.message` on a `400`** — that is how `MAGIC_CONTACT_UNVERIFIED` reaches the user
- **disable link previews** on these replies (`disable_web_page_preview` / `preview_url: false`).
  Belt and braces on top of the POST-not-GET design, and a tidier message
- send `X-Webhook-Secret` (already required for `/connect`)

Server-side, `STOREFRONT_URL` must be set or the reply falls back to the code alone — which still
works, but the one-tap path is gone.

## Related

- **[customer-auth.md](./customer-auth.md)** — the customer's flow end to end: where registration
  happens, what to deep-link, the page you owe, and what not to build
- [README.md](./README.md) — the rest of the auth surface
- [../connections/README.md](../connections/README.md) — `/connect`, the other bot-minted code
- [../whatsapp/README.md](../whatsapp/README.md), [../telegram/README.md](../telegram/README.md) — the bot bridges
